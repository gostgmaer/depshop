import { authResponse, loginInput, refreshInput, registerInput } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../plugins/auth.js";
import type { AuthService } from "./auth-service.js";

/** Stricter per-route limits for credential endpoints (brute-force protection). */
const credentialRateLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export const authRoutes: FastifyPluginAsyncZod<{ auth: AuthService }> = async (app, { auth }) => {
  const client = (req: { headers: Record<string, unknown>; ip: string }) => ({
    userAgent:
      typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    ipAddress: req.ip,
  });

  app.post(
    "/register",
    {
      config: credentialRateLimit,
      schema: {
        tags: ["auth"],
        summary: "Create a user account",
        body: registerInput,
        response: { 201: authResponse },
      },
    },
    async (req, reply) => reply.status(201).send(await auth.register(req.body, client(req))),
  );

  app.post(
    "/login",
    {
      config: credentialRateLimit,
      schema: {
        tags: ["auth"],
        summary: "Log in with email and password",
        body: loginInput,
        response: { 200: authResponse },
      },
    },
    async (req) => auth.login(req.body, client(req)),
  );

  app.post(
    "/refresh",
    {
      config: credentialRateLimit,
      schema: {
        tags: ["auth"],
        summary: "Rotate a refresh token",
        body: refreshInput,
        response: { 200: authResponse },
      },
    },
    async (req) => auth.refresh(req.body.refreshToken, client(req)),
  );

  app.post(
    "/logout",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["auth"],
        summary: "Revoke a refresh token",
        security: [{ bearerAuth: [] }],
        body: refreshInput,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await auth.logout(req.body.refreshToken, requireAuth(req).userId);
      return reply.status(204).send(null);
    },
  );
};
