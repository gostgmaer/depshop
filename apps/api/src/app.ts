import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import {
  type ZodTypeProvider,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Env } from "./config/env.js";
import { registerErrorHandler } from "./lib/error-handler.js";
import { TokenService } from "./lib/tokens.js";
import { adminUserRoutes } from "./modules/admin/admin-user-routes.js";
import { authRoutes } from "./modules/auth/auth-routes.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { type HealthCheck, healthRoutes } from "./modules/health/health-routes.js";
import { userRoutes } from "./modules/users/user-routes.js";
import type { UserStore } from "./modules/users/user-store.js";
import { authPlugin } from "./plugins/auth.js";

export interface AppDeps {
  env: Env;
  userStore: UserStore;
  healthChecks: Record<string, HealthCheck>;
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env } = deps;
  const app = Fastify({
    logger: deps.logger ?? {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "*.password",
          "*.refreshToken",
          "*.accessToken",
        ],
        censor: "[redacted]",
      },
    },
    trustProxy: true, // Behind Traefik
    bodyLimit: 1_048_576,
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(helmet, { contentSecurityPolicy: env.API_DOCS_ENABLED ? false : undefined });
  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  if (env.API_DOCS_ENABLED) {
    await app.register(swagger, {
      openapi: {
        info: { title: "DealMind AI API", version: "0.1.0" },
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  const tokens = new TokenService(env.JWT_ACCESS_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
  const auth = new AuthService(deps.userStore, tokens, env.REFRESH_TOKEN_TTL_DAYS);
  await app.register(authPlugin, { tokens });

  await app.register(healthRoutes, { prefix: "/health", checks: deps.healthChecks });
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: "/auth", auth });
      await v1.register(userRoutes, { prefix: "/users", store: deps.userStore });
      await v1.register(adminUserRoutes, { prefix: "/admin/users", store: deps.userStore });
    },
    { prefix: "/v1" },
  );

  return app;
}
