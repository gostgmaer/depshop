import { AppError, publicUser } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../plugins/auth.js";
import { type UserStore, toPublicUser } from "../users/user-store.js";

const adminUser = publicUser.extend({ status: z.enum(["ACTIVE", "SUSPENDED"]) });

export const adminUserRoutes: FastifyPluginAsyncZod<{ store: UserStore }> = async (
  app,
  { store },
) => {
  app.addHook("preHandler", app.requireRole("ADMIN"));

  app.get(
    "/",
    {
      schema: {
        tags: ["admin"],
        summary: "List users",
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().optional(),
          q: z.string().trim().min(1).max(100).optional(),
        }),
        response: {
          200: z.object({ items: z.array(adminUser), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      const { items, nextCursor } = await store.listUsers({
        limit: req.query.limit,
        cursor: req.query.cursor,
        query: req.query.q,
      });
      return { items: items.map((u) => ({ ...toPublicUser(u), status: u.status })), nextCursor };
    },
  );

  app.patch(
    "/:userId/status",
    {
      schema: {
        tags: ["admin"],
        summary: "Suspend or reactivate a user",
        security: [{ bearerAuth: [] }],
        params: z.object({ userId: z.string().min(1) }),
        body: z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }),
        response: { 200: adminUser },
      },
    },
    async (req) => {
      if (req.params.userId === requireAuth(req).userId) {
        throw AppError.forbidden("Admins cannot change their own status");
      }
      const user = await store.setUserStatus(req.params.userId, req.body.status);
      if (!user) throw AppError.notFound("User");
      if (req.body.status === "SUSPENDED") await store.revokeAllUserSessions(user.id);
      return { ...toPublicUser(user), status: user.status };
    },
  );
};
