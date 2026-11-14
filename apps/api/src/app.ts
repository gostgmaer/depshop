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
import { adminUserRoutes } from "./modules/admin/admin-user-routes.js";
import {
  type AuthRateLimits,
  DEFAULT_AUTH_RATE_LIMITS,
  authRoutes,
} from "./modules/auth/auth-routes.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { SessionService } from "./modules/auth/session-service.js";
import { EmailService } from "./modules/email/email-service.js";
import type { EmailTransport } from "./modules/email/email-transport.js";
import { type HealthCheck, healthRoutes } from "./modules/health/health-routes.js";
import { userRoutes } from "./modules/users/user-routes.js";
import { UserService } from "./modules/users/user-service.js";
import { authPlugin } from "./plugins/auth.js";
import { csrfPlugin } from "./plugins/csrf.js";

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  emailTransport: EmailTransport;
  healthChecks: Record<string, HealthCheck>;
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

  const sessions = new SessionService(prisma, {
    ttlDays: env.SESSION_TTL_DAYS,
    idleTimeoutDays: env.SESSION_IDLE_TIMEOUT_DAYS,
    ...(deps.sessionTouchIntervalMs === undefined
      ? {}
      : { touchIntervalMs: deps.sessionTouchIntervalMs }),
  });
  const email = new EmailService(deps.emailTransport, env.APP_URL, app.log);
  const throttle = new LoginThrottle(
    deps.loginThrottle ?? { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  );
  const auth = new AuthService(prisma, sessions, email, throttle, {
    emailVerificationTtlHours: env.EMAIL_VERIFICATION_TTL_HOURS,
    passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
  });
  const users = new UserService(prisma);

  await app.register(authPlugin, { sessions, cookies, secureCookies: env.COOKIE_SECURE });
  await app.register(healthRoutes, { prefix: "/health", checks: deps.healthChecks });
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
