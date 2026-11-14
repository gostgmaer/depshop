import {
  meResponse,
  preferencesSchema,
  updatePreferencesInput,
  updateProfileInput,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getAuth } from "../../plugins/auth.js";
import type { UserService } from "./user-service.js";

const security = [{ sessionCookie: [] }];

/** /users/me/*: the caller's own profile and preferences only. */
export const userRoutes: FastifyPluginAsyncZod<{ users: UserService }> = async (app, { users }) => {
  app.addHook("preHandler", app.requireAuth);

  app.patch(
    "/me",
    {
      schema: {
        tags: ["users"],
        summary: "Update your profile",
        security,
        body: updateProfileInput,
        response: { 200: meResponse },
      },
    },
    async (req) => ({ user: await users.updateProfile(getAuth(req).userId, req.body) }),
  );

  app.get(
    "/me/preferences",
    {
      schema: {
        tags: ["users"],
        summary: "Get your preferences",
        security,
        response: { 200: preferencesSchema },
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
        response: { 200: preferencesSchema },
      },
    },
    async (req) => users.updatePreferences(getAuth(req).userId, req.body),
  );
};
