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
import { LoginThrottle, type LoginThrottleOptions } from "./lib/login-throttle.js";
import { TokenCipher } from "./lib/token-cipher.js";
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
  loginThrottle?: Omit<LoginThrottleOptions, "now">;
  sessionTouchIntervalMs?: number;
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
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
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
  const throttle = new LoginThrottle(
    deps.loginThrottle ?? { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  );
  const auth = new AuthService(prisma, sessions, iam, verifier, throttle);
  const users = new UserService(prisma, sessions, iam);

  await app.register(authPlugin, { sessions, cookies, secureCookies: env.COOKIE_SECURE });
  await app.register(healthRoutes, {
    prefix: "/health",
    // Critical: the API cannot serve users without these.
    checks: {
      ...deps.healthChecks,
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
      await v1.register(userRoutes, { prefix: "/users", users });
      await v1.register(adminUserRoutes, { prefix: "/admin/users", prisma, sessions });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
