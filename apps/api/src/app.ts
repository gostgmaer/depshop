import { createHmac } from "node:crypto";
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
  NOTIFICATION_DELIVERY_JOB_OPTIONS,
  QueueName,
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
import {
  categoryRoutes,
  compareRoutes,
  productRoutes,
  sourceRoutes,
  dealRoutes,
} from "./modules/catalog/catalog-routes.js";
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
import {
  CatalogImporter,
  MatchReviewService,
  MatchService,
  MatchingEngine,
  PricingService,
} from "@dealmind/intelligence";
import { InternalIntelligence } from "./modules/internal/internal-intelligence.js";
import { internalRoutes } from "./modules/internal/internal-routes.js";
import { rankingKey } from "./modules/internal/ranking-token.js";
import { agentCanceller } from "./modules/internal/agent-client.js";
import {
  notificationPreferenceRoutes,
  notificationRoutes,
  pushRoutes,
  unsubscribeRoutes,
} from "./modules/notifications/notification-routes.js";
import { NotificationService } from "./modules/notifications/notification-service.js";
import { RealtimeHub } from "./modules/notifications/realtime-hub.js";
import { SearchService } from "./modules/search/search-service.js";
import { searchRoutes } from "./modules/search/search-routes.js";
import {
  type BillingProvider,
  EasyDevPaymentsProvider,
  EntitlementService,
  SandboxBillingProvider,
  SubscriptionSync,
  provisionProviderPlans,
} from "@dealmind/billing";
import {
  billingRoutes,
  billingWebhookRoutes,
  usageRoutes,
} from "./modules/billing/billing-routes.js";
import { BillingService } from "./modules/billing/billing-service.js";
import { AffiliateRegistry } from "@dealmind/affiliate";
import {
  adminAffiliateRoutes,
  affiliateClickRoutes,
} from "./modules/affiliate/affiliate-routes.js";
import { exportRoutes } from "./modules/billing/export-routes.js";
import { WatchlistService } from "./modules/watchlists/watchlist-service.js";
import { watchlistRoutes } from "./modules/watchlists/watchlist-routes.js";
import { envelopePlugin } from "./plugins/envelope.js";
import { createRedis, redisPlugin } from "./plugins/redis.js";
import { TokenCipher } from "./lib/token-cipher.js";
import { adminCatalogRoutes } from "./modules/admin/admin-catalog-routes.js";
import { AdminConsoleService } from "./modules/admin/admin-console-service.js";
import { adminConsoleRoutes } from "./modules/admin/admin-console-routes.js";
import { businessMetricsCollector } from "./plugins/business-metrics.js";
import { metricsPlugin } from "./plugins/metrics.js";
import { adminNotificationRoutes } from "./modules/admin/admin-notification-routes.js";
import { adminTrackingRoutes } from "./modules/admin/admin-tracking-routes.js";
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
import { GuestService } from "./modules/auth/guest-service.js";
import { setupRoutes } from "./modules/setup/setup-routes.js";
import { SetupService } from "./modules/setup/setup-service.js";
import { authPlugin } from "./plugins/auth.js";
import { csrfPlugin } from "./plugins/csrf.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Billing services (exposed for tests and the internal API). */
    billing: {
      service: BillingService;
      provider: BillingProvider | null;
      entitlements: EntitlementService;
    };
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
  /** Billing provider override (tests inject the sandbox); otherwise chosen by BILLING_PROVIDER. */
  billingProvider?: BillingProvider | null;
  /** Clock override for billing (tests). */
  billingNow?: () => Date;
  /** Affiliate program registry override (tests inject mock providers). */
  affiliateRegistry?: AffiliateRegistry;
  /** fetch for partner report APIs (tests). */
  affiliateFetch?: typeof fetch;
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
      // Every line says which service and deployment (development/staging/production) it came from.
      base: { service: "dealmind-api", env: process.env.DEPLOY_ENV ?? env.NODE_ENV },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
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
      // Phase 7.1: log the path only. Query strings can hold search text and
      // other personal data; the route and request id are enough to correlate.
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({
          method: req.method,
          url: req.url.split("?")[0],
          reqId: req.id,
        }),
      },
    },
    trustProxy: trustProxy(env.TRUST_PROXY),
    bodyLimit: 1_048_576,
    // Correlation: keep the web tier's x-request-id when well-formed, else a new UUID.
    requestIdHeader: false,
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(given)
        ? given
        : crypto.randomUUID();
    },
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
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  await app.register(metricsPlugin, {
    token: env.METRICS_TOKEN,
    jobs,
    queueNames: Object.values(QueueName),
    collect: businessMetricsCollector(
      prisma,
      new RedisMetricsStore(redis, env.REDIS_KEY_PREFIX, () => undefined),
    ),
  });
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
  const notificationService = new NotificationService({
    prisma,
    redis,
    redisPrefix: env.REDIS_KEY_PREFIX,
    jobs,
    tokenSecret: env.NOTIFICATION_TOKEN_SECRET ?? null,
    log: app.log,
  });
  const hub = new RealtimeHub(redis, env.REDIS_KEY_PREFIX);
  app.addHook("onClose", async () => hub.close());
  const auth = new AuthService(prisma, sessions, iam, verifier, throttle, {
    signedIn: (u, s, ua) => notificationService.signedIn(u, s, ua),
    passwordChanged: (u, a) => notificationService.passwordChanged(u, a),
    log: app.log,
  });
  const setup = new SetupService(prisma, {
    ...(env.ADMIN_SETUP_TOKEN ? { configuredToken: env.ADMIN_SETUP_TOKEN } : {}),
    register: (input) => auth.register(input, {}),
  });
  auth.firstRunSetup = setup;
  // While no administrator exists, make sure a one-time setup token is ready (and logged).
  app.addHook("onReady", async () => {
    await setup
      .prepare(app.log)
      .catch((err: unknown) =>
        app.log.error({ err: (err as Error).message }, "first-run setup check failed"),
      );
  });
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
  const entitlements = new EntitlementService(prisma, {
    graceDays: env.BILLING_GRACE_DAYS,
    launchPlan: env.LAUNCH_FREE_PLAN ?? null,
    ...(deps.billingNow ? { now: deps.billingNow } : {}),
  });
  const billingProvider: BillingProvider | null =
    deps.billingProvider !== undefined
      ? deps.billingProvider
      : env.BILLING_PROVIDER === "easydev-payments"
        ? new EasyDevPaymentsProvider({
            baseUrl: env.PAYMENT_SERVICE_URL!,
            apiKey: env.PAYMENT_SERVICE_API_KEY!,
            tenantId: env.PAYMENT_TENANT_ID,
            applicationId: env.PAYMENT_APPLICATION_ID,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
          })
        : env.BILLING_PROVIDER === "sandbox"
          ? new SandboxBillingProvider()
          : null;
  // The in-memory sandbox registers its plans at startup; the real service is
  // provisioned explicitly (pnpm --filter @dealmind/api billing:sync-plans).
  if (billingProvider instanceof SandboxBillingProvider)
    await provisionProviderPlans(prisma, entitlements, billingProvider);
  const billingSync = billingProvider
    ? new SubscriptionSync({
        prisma,
        provider: billingProvider,
        entitlements,
        graceDays: env.BILLING_GRACE_DAYS,
        realtime: { redis, prefix: env.REDIS_KEY_PREFIX },
        enqueueDelivery: async (deliveryId, notBefore) => {
          const delay = notBefore ? Math.max(0, notBefore.getTime() - Date.now()) : 0;
          await jobs.enqueue(
            QueueName.notificationDelivery,
            { deliveryId },
            { ...NOTIFICATION_DELIVERY_JOB_OPTIONS, ...(delay ? { delay } : {}) },
          );
        },
        ...(deps.billingNow ? { now: deps.billingNow } : {}),
      })
    : null;
  const billing = new BillingService(prisma, entitlements, billingProvider, billingSync, {
    applicationId: env.PAYMENT_APPLICATION_ID,
    webhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? null,
    graceDays: env.BILLING_GRACE_DAYS,
    log: app.log,
    ...(deps.billingNow ? { now: deps.billingNow } : {}),
  });
  app.decorate("billing", { service: billing, provider: billingProvider, entitlements });
  // Admin console: connector readiness reports credential NAMES only (no values).
  const adminConsole = new AdminConsoleService({
    prisma,
    jobs,
    entitlements,
    registry:
      deps.connectorRegistry ??
      createDefaultRegistry(env, { includeMocks: env.CONNECTORS_ALLOW_MOCKS }),
    metrics: new RedisMetricsStore(redis, env.REDIS_KEY_PREFIX, () => undefined),
    checks: {
      ...deps.healthChecks,
      redis: async () => {
        await redis.ping();
      },
      iam: () => iam.health(),
      notifications: notifications ? () => notifications.health() : null,
      files: files ? () => files.health() : null,
      agent: env.AGENT_SERVICE_URL
        ? async () => {
            const res = await (deps.fetch ?? fetch)(`${env.AGENT_SERVICE_URL}/health`, {
              signal: AbortSignal.timeout(3_000),
            });
            if (!res.ok) throw new Error(String(res.status));
          }
        : null,
      worker: async () => {
        // A worker is connected to the notification queue (it runs in every worker process).
        if (!(await jobs.queue(QueueName.notificationDelivery).getWorkers()).length)
          throw new Error("no worker");
      },
      payments:
        env.BILLING_PROVIDER === "easydev-payments" && env.PAYMENT_SERVICE_URL
          ? async () => {
              const res = await (deps.fetch ?? fetch)(`${env.PAYMENT_SERVICE_URL}/health`, {
                signal: AbortSignal.timeout(3_000),
              });
              if (!res.ok) throw new Error(String(res.status));
            }
          : null,
    },
  });
  const affiliateRegistry =
    deps.affiliateRegistry ??
    new AffiliateRegistry({
      amazonPartnerTag: env.AMAZON_ASSOCIATES_PARTNER_TAG ?? null,
      flipkartAffiliateId: env.FLIPKART_AFFILIATE_ID ?? null,
      flipkartAffiliateToken: env.FLIPKART_AFFILIATE_TOKEN ?? null,
    });
  const affiliateDeps = {
    prisma,
    registry: affiliateRegistry,
    redis,
    redisPrefix: env.REDIS_KEY_PREFIX,
    // IP hashes use a key derived from the session secret (never stored, never sent).
    ipSalt: createHmac("sha256", env.SESSION_SECRET).update("dealmind:affiliate-ip").digest("hex"),
    ...(deps.affiliateFetch ? { fetch: deps.affiliateFetch } : {}),
  };
  const pricing = new PricingService(prisma);
  const search = new SearchService(
    prisma,
    jobs,
    entitlements,
    cache,
    app.log,
    env.CATALOG_OFFER_STALE_HOURS * 3_600_000,
    {
      redis,
      redisPrefix: env.REDIS_KEY_PREFIX,
      pricing,
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
  const watchlists = new WatchlistService(
    prisma,
    entitlements,
    env.CATALOG_OFFER_STALE_HOURS * 3_600_000,
  );
  const alerts = new AlertService(prisma, entitlements);

  const guests = new GuestService(prisma, env.SESSION_SECRET);
  await app.register(authPlugin, { sessions, guests, cookies, secureCookies: env.COOKIE_SECURE });
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
      await v1.register(setupRoutes, { prefix: "/setup", setup });
      await v1.register(authRoutes, {
        prefix: "/auth",
        auth,
        sessions,
        users,
        rateLimits: deps.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS,
      });
      await v1.register(userRoutes, { prefix: "/users", users, sessions, auth, prisma });
      await v1.register(adminUserRoutes, { prefix: "/admin/users", prisma, sessions });
      await v1.register(adminConsoleRoutes, {
        prefix: "/admin",
        prisma,
        console: adminConsole,
        sessions,
        redis,
        redisPrefix: env.REDIS_KEY_PREFIX,
        agentHealth: env.AGENT_SERVICE_URL
          ? async () => {
              const res = await (deps.fetch ?? fetch)(`${env.AGENT_SERVICE_URL}/health`, {
                signal: AbortSignal.timeout(3_000),
              });
              if (!res.ok) throw new Error(`agent health ${res.status}`);
              // Names only (provider/model); the agent never returns keys.
              const body = (await res.json()) as Record<string, unknown>;
              return { status: body.status, provider: body.provider, model: body.model };
            }
          : null,
        enqueueHealthCheck: async () => {
          const jobId = `connector-health-manual-${Date.now()}`;
          await jobs
            .queue(QueueName.connectorHealth)
            .add(QueueName.connectorHealth, {}, { jobId, removeOnComplete: 100 });
          return jobId;
        },
      });
      await v1.register(adminTrackingRoutes, {
        prefix: "/admin",
        prisma,
        redis,
        redisPrefix: env.REDIS_KEY_PREFIX,
        jobs,
      });
      await v1.register(adminNotificationRoutes, {
        prefix: "/admin/notifications",
        prisma,
        redis,
        redisPrefix: env.REDIS_KEY_PREFIX,
      });
      await v1.register(adminCatalogRoutes, { prefix: "/admin/catalog", prisma, catalog });
      await v1.register(categoryRoutes, { prefix: "/categories", catalog });
      await v1.register(productRoutes, {
        prefix: "/products",
        catalog,
        pricing,
        entitlements,
      });
      await v1.register(compareRoutes, {
        prefix: "/compare",
        catalog,
        pricing,
        entitlements,
      });
      await v1.register(sourceRoutes, { prefix: "/sources", catalog });
      await v1.register(dealRoutes, { prefix: "/deals", catalog });
      await v1.register(searchRoutes, {
        prefix: "/search",
        search,
        redis,
        redisPrefix: env.REDIS_KEY_PREFIX,
      });
      await v1.register(watchlistRoutes, { prefix: "/watchlists", watchlists });
      await v1.register(alertRoutes, { prefix: "/alerts", alerts });
      await v1.register(unsubscribeRoutes, {
        prefix: "/notifications/unsubscribe",
        notifications: notificationService,
      });
      await v1.register(notificationRoutes, {
        prefix: "/notifications",
        notifications: notificationService,
        hub,
      });
      await v1.register(notificationPreferenceRoutes, {
        prefix: "/users/me/notification-preferences",
        notifications: notificationService,
      });
      await v1.register(pushRoutes, {
        prefix: "/push",
        notifications: notificationService,
        vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
      });
      await v1.register(billingRoutes, { prefix: "/billing", billing });
      await v1.register(usageRoutes, { prefix: "/usage", billing });
      await v1.register(affiliateClickRoutes, { prefix: "/affiliate", ...affiliateDeps });
      await v1.register(adminAffiliateRoutes, { prefix: "/admin/affiliates", ...affiliateDeps });
      await v1.register(exportRoutes, { prefix: "/exports", prisma, entitlements });
    },
    { prefix: "/api/v1" },
  );

  // Payment-service webhooks: outside /api (signature-authenticated, raw body).
  await app.register(billingWebhookRoutes, { prefix: "/webhooks", billing });

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
    const onProductsChanged = (ids: string[]) =>
      invalidateProductCaches(redis, env.REDIS_KEY_PREFIX, ids);
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
      rankingKey: rankingKey(env.SESSION_SECRET),
      catalog,
      allowMocks: env.CONNECTORS_ALLOW_MOCKS,
    });
  }

  return app;
}
