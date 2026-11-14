/**
 * The caller's in-app notifications. Every query is scoped by the
 * authenticated userId; another user's notification is "not found".
 */
import type { PrismaClient } from "@dealmind/db";
import { AppError, notificationListQuery, notificationView, paginationOf } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { iso, ok, page, paginated } from "../../utils/http.js";

const security = [{ sessionCookie: [] }];

type Row = {
  id: string;
  type: string;
  title: string;
  body: string;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
};
const view = (n: Row) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  data: (n.data ?? {}) as Record<string, unknown>,
  readAt: iso(n.readAt),
  createdAt: n.createdAt.toISOString(),
});

export const notificationRoutes: FastifyPluginAsyncZod<{ prisma: PrismaClient }> = async (
  app,
  { prisma },
) => {
  app.addHook("preHandler", app.requireAuth);

  app.get(
    "/",
    {
      schema: {
        tags: ["notifications"],
        summary: "Your notifications, newest first",
        security,
        querystring: notificationListQuery,
        response: { 200: page(notificationView) },
      },
    },
    async (req) => {
      const userId = getAuth(req).userId;
      const q = req.query;
      const where = { userId, ...(q.unread === true ? { readAt: null } : {}) };
      const [rows, total] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.notification.count({ where }),
      ]);
      return paginated(rows.map(view), paginationOf(q, total));
    },
  );

  app.get(
    "/unread-count",
    {
      schema: {
        tags: ["notifications"],
        summary: "Number of unread notifications",
        security,
        response: { 200: ok(z.object({ unread: z.number().int() })) },
      },
    },
    async (req) => ({
      unread: await prisma.notification.count({
        where: { userId: getAuth(req).userId, readAt: null },
      }),
    }),
  );

  app.post(
    "/:id/read",
    {
      schema: {
        tags: ["notifications"],
        summary: "Mark one notification as read",
        security,
        params: z.object({ id: z.string().uuid() }),
        response: { 200: ok(notificationView) },
      },
    },
    async (req) => {
      const userId = getAuth(req).userId;
      const existing = await prisma.notification.findFirst({
        where: { id: req.params.id, userId },
      });
      if (!existing) throw AppError.notFound("Notification");
      if (existing.readAt) return view(existing);
      return view(
        await prisma.notification.update({
          where: { id: existing.id },
          data: { readAt: new Date() },
        }),
      );
    },
  );

  app.post(
    "/read-all",
    {
      schema: {
        tags: ["notifications"],
        summary: "Mark all notifications as read",
        security,
        response: { 200: ok(z.object({ updated: z.number().int() })) },
      },
    },
    async (req) => {
      const res = await prisma.notification.updateMany({
        where: { userId: getAuth(req).userId, readAt: null },
        data: { readAt: new Date() },
      });
      return { updated: res.count };
    },
  );
};
