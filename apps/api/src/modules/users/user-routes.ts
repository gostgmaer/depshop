import {
  meResponse,
  sessionsResponse,
  preferencesSchema,
  updatePreferencesInput,
  updateProfileInput,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AuthService } from "../auth/auth-service.js";
import type { SessionService } from "../auth/session-service.js";
import { ok } from "../../utils/http.js";
import { getAuth } from "../../plugins/auth.js";
import type { UserService } from "./user-service.js";

const security = [{ sessionCookie: [] }];

/** /users/me/*: the caller's own profile and preferences only. */
export interface UserRoutesOptions {
  users: UserService;
  sessions: SessionService;
  auth: AuthService;
}

export const userRoutes: FastifyPluginAsyncZod<UserRoutesOptions> = async (
  app,
  { users, sessions, auth },
) => {
  app.addHook("preHandler", app.requireAuth);

  app.get(
    "/me",
    {
      schema: {
        tags: ["users"],
        summary: "The signed-in user",
        security,
        response: { 200: ok(meResponse) },
      },
    },
    async (req) => ({ user: await users.getMe(getAuth(req).userId) }),
  );

  app.get(
    "/me/sessions",
    {
      schema: {
        tags: ["users"],
        summary: "Your active sessions",
        security,
        response: { 200: ok(sessionsResponse) },
      },
    },
    async (req) => {
      const me = getAuth(req);
      const rows = await sessions.listActive(me.userId);
      return {
        sessions: rows.map((s) => ({
          id: s.id,
          current: s.id === me.sessionId,
          userAgent: s.userAgent,
          ipAddress: s.ipAddress,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
        })),
      };
    },
  );

  app.delete(
    "/me/sessions/:id",
    {
      schema: {
        tags: ["users"],
        summary: "Revoke one of your sessions",
        security,
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const me = getAuth(req);
      await auth.revokeSession(me, req.params.id);
      if (req.params.id === me.sessionId) app.clearSessionCookie(reply);
      return reply.status(204).send(null);
    },
  );

  app.patch(
    "/me",
    {
      schema: {
        tags: ["users"],
        summary: "Update your profile",
        security,
        body: updateProfileInput,
        response: { 200: ok(meResponse) },
      },
    },
    async (req) => ({ user: await users.updateProfile(getAuth(req), req.body) }),
  );

  app.get(
    "/me/preferences",
    {
      schema: {
        tags: ["users"],
        summary: "Get your preferences",
        security,
        response: { 200: ok(preferencesSchema) },
      },
    },
    async (req) => users.getPreferences(getAuth(req).userId),
  );

  app.patch(
    "/me/preferences",
    {
      schema: {
        tags: ["users"],
        summary: "Update your preferences",
        security,
        body: updatePreferencesInput,
        response: { 200: ok(preferencesSchema) },
      },
    },
    async (req) => users.updatePreferences(getAuth(req).userId, req.body),
  );
};
