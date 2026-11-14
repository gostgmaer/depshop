import { AppError, publicUser } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireAuth } from "../../plugins/auth.js";
import { type UserStore, toPublicUser } from "./user-store.js";

export const userRoutes: FastifyPluginAsyncZod<{ store: UserStore }> = async (app, { store }) => {
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/me",
    {
      schema: {
        tags: ["users"],
        summary: "Get the authenticated user's profile",
        security: [{ bearerAuth: [] }],
        response: { 200: publicUser },
      },
    },
    async (req) => {
      const user = await store.findUserById(requireAuth(req).userId);
      if (!user) throw AppError.notFound("User");
      return toPublicUser(user);
    },
  );
};
