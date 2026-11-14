import type { PrismaClient } from "@dealmind/db";
import { AppError, UserRole, UserStatus, publicUser } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import type { SessionService } from "../auth/session-service.js";
import { recordAudit } from "../users/audit.js";
import { toPublicUser, userSelect } from "../users/user-view.js";

const adminUser = publicUser.extend({ status: UserStatus });
const security = [{ sessionCookie: [] }];
const adminSelect = { ...userSelect, status: true } as const;

export interface AdminUserRoutesOptions {
  prisma: PrismaClient;
  sessions: SessionService;
}

/** Platform administration. Every route requires the ADMIN role (checked server-side). */
export const adminUserRoutes: FastifyPluginAsyncZod<AdminUserRoutesOptions> = async (
  app,
  { prisma, sessions },
) => {
  app.addHook("preHandler", app.requireAdmin);

  app.get(
    "/",
    {
      schema: {
        tags: ["admin"],
        summary: "List users",
        security,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().uuid().optional(),
          q: z.string().trim().min(1).max(100).optional(),
        }),
        response: {
          200: z.object({ items: z.array(adminUser), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      const { limit, cursor, q } = req.query;
      const rows = await prisma.user.findMany({
        where: q
          ? {
              OR: [
                { email: { contains: q, mode: "insensitive" } },
                { name: { contains: q, mode: "insensitive" } },
              ],
            }
          : undefined,
        orderBy: { id: "asc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: adminSelect,
      });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: items.map((u) => ({ ...toPublicUser(u), status: u.status })),
        nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.patch(
    "/:userId/status",
    {
      schema: {
        tags: ["admin"],
        summary: "Suspend or reactivate a user (suspension signs out all their sessions)",
        security,
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({ status: UserStatus }).strict(),
        response: { 200: adminUser },
      },
    },
    async (req) => {
      const actor = getAuth(req);
      if (req.params.userId === actor.userId)
        throw AppError.forbidden("Admins cannot change their own status");
      const user = await prisma.user.update({
        where: { id: req.params.userId },
        data: { status: req.body.status },
        select: adminSelect,
      });
      if (req.body.status === "SUSPENDED") await sessions.revokeAllForUser(user.id);
      await recordAudit(prisma, {
        actorId: actor.userId,
        action: "admin.user_status_changed",
        entity: "User",
        entityId: user.id,
        metadata: { status: req.body.status },
      });
      return { ...toPublicUser(user), status: user.status };
    },
  );

  app.patch(
    "/:userId/role",
    {
      schema: {
        tags: ["admin"],
        summary: "Change a user's role (privilege change: signs out all their sessions)",
        security,
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({ role: UserRole }).strict(),
        response: { 200: adminUser },
      },
    },
    async (req) => {
      const actor = getAuth(req);
      if (req.params.userId === actor.userId)
        throw AppError.forbidden("Admins cannot change their own role");
      const user = await prisma.user.update({
        where: { id: req.params.userId },
        data: { role: req.body.role },
        select: adminSelect,
      });
      // Privilege change: force re-authentication so new sessions carry fresh identifiers.
      await sessions.revokeAllForUser(user.id);
      await recordAudit(prisma, {
        actorId: actor.userId,
        action: "admin.user_role_changed",
        entity: "User",
        entityId: user.id,
        metadata: { role: req.body.role },
      });
      return { ...toPublicUser(user), status: user.status };
    },
  );
};
