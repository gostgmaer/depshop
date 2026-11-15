import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { PrismaClient } from "@dealmind/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import {
  type ZodTypeProvider,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Env } from "./config/env.js";
import { cookieNames } from "./lib/cookies.js";
import { CsrfTokens } from "./lib/csrf.js";
import { registerErrorHandler } from "./lib/error-handler.js";
import {
  type JobQueues,
  JobQueues as JobQueuesImpl,
  redisConnectionFromUrl,
} from "@dealmind/queue";
import type { Redis } from "ioredis";
import { CacheService } from "./lib/cache.js";
import {
  type LoginThrottle,
  type LoginThrottleOptions,
  RedisLoginThrottle,
} from "./lib/login-throttle.js";
import { AlertService } from "./modules/alerts/alert-service.js";
import { alertRoutes } from "./modules/alerts/alert-routes.js";
import { categoryRoutes, productRoutes, sourceRoutes } from "./modules/catalog/catalog-routes.js";
import { CatalogService } from "./modules/catalog/catalog-service.js";
import {
  type ConnectorRegistry,
  ParallelSearchExecutor,
  PrismaSourceConfigProvider,
  PrismaSourceStatusStore,
  RedisMetricsStore,
  RedisRateLimiter,
  RedisResponseCache,
  createDefaultRegistry,
} from "@dealmind/connectors";
import { invalidateProductCaches } from "@dealmind/catalog";
import { CatalogImporter, MatchReviewService, MatchService, MatchingEngine } from "@dealmind/intelligence";
import { InternalIntelligence } from "./modules/internal/internal-intelligence.js";
import { internalRoutes } from "./modules/internal/internal-routes.js";
import { agentCanceller } from "./modules/internal/agent-client.js";
import { notificationRoutes } from "./modules/notifications/notification-routes.js";
import { SearchService } from "./modules/search/search-service.js";
import { searchRoutes } from "./modules/search/search-routes.js";
import { PlanService } from "./modules/subscriptions/plan-service.js";
import { subscriptionRoutes } from "./modules/subscriptions/subscription-routes.js";
import { WatchlistService } from "./modules/watchlists/watchlist-service.js";
import { watchlistRoutes } from "./modules/watchlists/watchlist-routes.js";
import { envelopePlugin } from "./plugins/envelope.js";
import { createRedis, redisPlugin } from "./plugins/redis.js";
import { TokenCipher } from "./lib/token-cipher.js";
import { adminCatalogRoutes } from "./modules/admin/admin-catalog-routes.js";
import { adminPlatformRoutes } from "./modules/admin/admin-platform-routes.js";
import { adminUserRoutes } from "./modules/admin/admin-user-routes.js";
import {
  type AuthRateLimits,
  DEFAULT_AUTH_RATE_LIMITS,
  authRoutes,
} from "./modules/auth/auth-routes.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { SessionService } from "./modules/auth/session-service.js";
import { IamClient } from "./modules/iam/iam-client.js";
import { IamTokenVerifier } from "./modules/iam/iam-token-verifier.js";
import { FileGateway } from "./modules/platform/file-gateway.js";
import { NotificationGateway } from "./modules/platform/notification-gateway.js";
import { type HealthCheck, healthRoutes } from "./modules/health/health-routes.js";
import { userRoutes } from "./modules/users/user-routes.js";
import { UserService } from "./modules/users/user-service.js";
import { authPlugin } from "./plugins/auth.js";
import { csrfPlugin } from "./plugins/csrf.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Shared EasyDev platform services. notifications/files are null when not configured. */
    platform: {
      iam: IamClient;
      notifications: NotificationGateway | null;
      files: FileGateway | null;
    };
  }
}

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  /** Critical readiness checks supplied by the host (e.g. database). */
  healthChecks: Record<string, HealthCheck>;
  /** Overridable for tests (e.g. a fake IAM's fetch). */
  fetch?: typeof fetch;
  logger?: FastifyServerOptions["logger"];
  /** Overridable for tests; production uses the defaults. */
  rateLimits?: AuthRateLimits;
  loginThrottle?: LoginThrottleOptions;
  /** Global per-IP limit (requests/minute). */
  globalRateLimit?: number;
  /** Injected Redis client / queues (tests); otherwise created from env. */
  redis?: Redis;
  jobs?: JobQueues;
  sessionTouchIntervalMs?: number;
  /** Connector registry for the internal API (tests inject scripted connectors). */
  connectorRegistry?: ConnectorRegistry;
}

function trustProxy(value: string): boolean | string {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, prisma } = deps;
  const app = Fastify({
    logger: deps.logger ?? {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
          "*.password",
          "*.currentPassword",
          "*.newPassword",
          "*.token",
        ],
        censor: "[redacted]",
      },
    },
    trustProxy: trustProxy(env.TRUST_PROXY),
    bodyLimit: 1_048_576,
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  const cookies = cookieNames(env.COOKIE_SECURE);

  await app.register(helmet, { contentSecurityPolicy: env.API_DOCS_ENABLED ? false : undefined });
  // The web app calls the API same-origin through its /api proxy; CORS only
  // matters for explicitly allow-listed extra origins.
  await app.register(cors, { origin: env.ALLOWED_ORIGINS, credentials: true });
  await app.register(cookie);
  const redis = deps.redis ?? createRedis(env.REDIS_URL);
  await app.register(redisPlugin, { redis });
  const jobs =
    deps.jobs ??
    new JobQueuesImpl({
      connection: redisConnectionFromUrl(env.REDIS_URL),
      prefix: `${env.REDIS_KEY_PREFIX}:bull`,
    });
  app.addHook("onClose", async () => {
    await jobs.close();
  });
  await app.register(envelopePlugin);
  // Shared across API instances via Redis. If Redis is down, requests are
  // allowed (skipOnError) rather than rejecting all traffic; /ready reports it.
  await app.register(rateLimit, {
    global: true,
    max: deps.globalRateLimit ?? 300,
    timeWindow: "1 minute",
    redis,
    nameSpace: `${env.REDIS_KEY_PREFIX}:rl:`,
    skipOnError: true,
  });
  await app.register(csrfPlugin, {
    csrf: new CsrfTokens(env.SESSION_SECRET),
    cookies,
    secureCookies: env.COOKIE_SECURE,
    allowedOrigins: env.ALLOWED_ORIGINS,
  });

  if (env.API_DOCS_ENABLED) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "DealMind AI API",
          version: "0.2.0",
          description:
            "Cookie-session API. Call GET /api/v1/auth/csrf first and send the token as `x-csrf-token` on every POST/PATCH/DELETE.",
        },
        components: {
          securitySchemes: {
            sessionCookie: { type: "apiKey", in: "cookie", name: cookies.session },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  const iamFetch = deps.fetch ?? fetch;
  const iam = new IamClient({
    baseUrl: env.IAM_BASE_URL,
    tenant: env.IAM_TENANT,
    timeoutMs: env.IAM_TIMEOUT_MS,
    appUrl: env.APP_URL,
    fetch: iamFetch,
  });
  const verifier = new IamTokenVerifier({
    jwksUrl: env.IAM_JWKS_URL,
    issuer: env.IAM_JWT_ISSUER,
    audience: env.IAM_JWT_AUDIENCE,
    timeoutMs: env.IAM_TIMEOUT_MS,
    fetch: iamFetch,
  });
  const notifications = env.NOTIFICATION_SERVICE_URL
    ? new NotificationGateway({
        baseUrl: env.NOTIFICATION_SERVICE_URL,
        apiKey: env.NOTIFICATION_API_KEY,
        tenantId: env.NOTIFICATION_TENANT_ID,
        timeoutMs: 5_000,
      })
    : null;
  const files = env.FILE_SERVICE_URL
    ? new FileGateway({
        baseUrl: env.FILE_SERVICE_URL,
        hmacSecret: env.FILE_SERVICE_HMAC_SECRET,
        tenantId: env.FILE_SERVICE_TENANT_ID,
      })
    : null;
  app.decorate("platform", { iam, notifications, files });

  const sessions = new SessionService(
    prisma,
    new TokenCipher(env.TOKEN_ENCRYPTION_KEY),
    iam,
    verifier,
    {
      ttlDays: env.SESSION_TTL_DAYS,
      idleTimeoutDays: env.SESSION_IDLE_TIMEOUT_DAYS,
      ...(deps.sessionTouchIntervalMs === undefined
        ? {}
        : { touchIntervalMs: deps.sessionTouchIntervalMs }),
    },
  );
  const throttle: LoginThrottle = new RedisLoginThrottle(
    redis,
    env.REDIS_KEY_PREFIX,
    deps.loginThrottle ?? { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
    (err) =>
      app.log.error({ err: (err as Error).message }, "login throttle unavailable (failing open)"),
  );
  const auth = new AuthService(prisma, sessions, iam, verifier, throttle);
  const users = new UserService(prisma, sessions, iam);
  const cache = new CacheService(redis, env.REDIS_KEY_PREFIX, app.log);
  const catalog = new CatalogService(prisma, cache, {
    ttl: {
      categories: env.CATALOG_CATEGORY_TTL_SECONDS,
      product: env.CATALOG_PRODUCT_TTL_SECONDS,
      offers: env.CATALOG_OFFER_TTL_SECONDS,
      history: env.CATALOG_HISTORY_TTL_SECONDS,
    },
    offerStaleAfterMs: env.CATALOG_OFFER_STALE_HOURS * 3_600_000,
    metrics: new RedisMetricsStore(redis, env.REDIS_KEY_PREFIX, (err) =>
      app.log.warn({ err: (err as Error).message }, "connector metrics unavailable"),
    ),
  });
  const plans = new PlanService(prisma);
  const search = new SearchService(
    prisma,
    jobs,
    plans,
    cache,
    app.log,
    env.CATALOG_OFFER_STALE_HOURS * 3_600_000,
    {
      redis,
      redisPrefix: env.REDIS_KEY_PREFIX,
      ...(env.AGENT_SERVICE_URL && env.AGENT_SERVICE_TOKEN
        ? {
            cancelExecution: agentCanceller(
              env.AGENT_SERVICE_URL,
              env.AGENT_SERVICE_TOKEN,
              deps.fetch,
            ),
          }
        : {}),
    },
  );
  const watchlists = new WatchlistService(prisma, plans, env.CATALOG_OFFER_STALE_HOURS * 3_600_000);
  const alerts = new AlertService(prisma, plans);

  await app.register(authPlugin, { sessions, cookies, secureCookies: env.COOKIE_SECURE });
  await app.register(healthRoutes, {
    // Critical: the API cannot serve users without these.
    checks: {
      ...deps.healthChecks,
      redis: async () => {
        await redis.ping();
      },
      iam: () => iam.health(),
      iamJwks: () => verifier.health(),
    },
    // Reported, but not yet required by any feature.
    optionalChecks: {
      ...(notifications ? { notifications: () => notifications.health() } : {}),
      ...(files ? { files: () => files.health() } : {}),
    },
  });
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, {
        prefix: "/auth",
        auth,
        sessions,
        users,
        rateLimits: deps.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS,
      });
      await v1.register(userRoutes, { prefix: "/users", users, sessions, auth });
      await v1.register(adminUserRoutes, { prefix: "/admin/users", prisma, sessions });
      await v1.register(adminPlatformRoutes, { prefix: "/admin", prisma });
      await v1.register(adminCatalogRoutes, { prefix: "/admin/catalog", prisma, catalog });
      await v1.register(categoryRoutes, { prefix: "/categories", catalog });
      await v1.register(productRoutes, { prefix: "/products", catalog });
      await v1.register(sourceRoutes, { prefix: "/sources", catalog });
      await v1.register(searchRoutes, {
        prefix: "/search",
        search,
        redis,
        redisPrefix: env.REDIS_KEY_PREFIX,
      });
      await v1.register(watchlistRoutes, { prefix: "/watchlists", watchlists });
      await v1.register(alertRoutes, { prefix: "/alerts", alerts });
      await v1.register(notificationRoutes, { prefix: "/notifications", prisma });
      await v1.register(subscriptionRoutes, { prefix: "/subscriptions", plans });
    },
    { prefix: "/api/v1" },
  );

  // Internal service API for the Python agent: only when explicitly configured.
  if (env.INTERNAL_API_TOKEN && env.AGENT_USER_CONTEXT_SECRET) {
    const onRedisError = (err: unknown) =>
      app.log.warn({ err: (err as Error).message }, "connector redis operation failed");
    const registry =
      deps.connectorRegistry ??
      createDefaultRegistry(env, { includeMocks: env.CONNECTORS_ALLOW_MOCKS });
    const sources = new PrismaSourceConfigProvider(prisma);
    const executor = new ParallelSearchExecutor({
      registry,
      sources,
      statusStore: new PrismaSourceStatusStore(prisma),
      rateLimiter: new RedisRateLimiter(redis, env.REDIS_KEY_PREFIX, onRedisError),
      cache: new RedisResponseCache(redis, env.REDIS_KEY_PREFIX, onRedisError),
      metrics: new RedisMetricsStore(redis, env.REDIS_KEY_PREFIX, onRedisError),
      concurrency: env.CONNECTOR_CONCURRENCY,
      allowMocks: env.CONNECTORS_ALLOW_MOCKS,
      logger: app.log,
    });
    const onProductsChanged = (ids: string[]) => invalidateProductCaches(redis, env.REDIS_KEY_PREFIX, ids);
    const engine = new MatchingEngine();
    const importer = new CatalogImporter(prisma, { engine, onProductsChanged });
    await app.register(internalRoutes, {
      prefix: "/internal/v1",
      prisma,
      redis,
      redisPrefix: env.REDIS_KEY_PREFIX,
      token: env.INTERNAL_API_TOKEN,
      userContextSecret: env.AGENT_USER_CONTEXT_SECRET,
      registry,
      sources,
      executor,
      intelligence: new InternalIntelligence(prisma, importer),
      matches: new MatchService(prisma, engine),
      reviews: new MatchReviewService(prisma, importer, onProductsChanged),
      reviewContextSecret: env.REVIEW_CONTEXT_SECRET ?? null,
      catalog,
      allowMocks: env.CONNECTORS_ALLOW_MOCKS,
    });
  }

  return app;
}
