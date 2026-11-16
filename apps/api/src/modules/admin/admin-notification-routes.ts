/**
 * Notification delivery operations (ADMIN only): delivery outcomes per
 * channel, overdue PENDING deliveries (outbox backlog), common failure
 * reasons, notifications per type, push subscription health and the
 * worker's delivery counters. Aggregates only: no titles, bodies, addresses
 * or user ids.
 */
import type { PrismaClient } from "@dealmind/db";
import { readTrackingSummary } from "@dealmind/queue";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z } from "zod";
import { ok } from "../../utils/http.js";

const security = [{ sessionCookie: [] }];
const counts = z.record(z.number().int());

export const notificationOverview = z.object({
  hours: z.number().int(),
  deliveries: z.record(counts),
  overduePending: z.number().int(),
  topFailures: z.array(
    z.object({ channel: z.string(), reason: z.string(), count: z.number().int() }),
  ),
  notificationsByType: counts,
  pushSubscriptions: z.object({
    active: z.number().int(),
    expired: z.number().int(),
    revoked: z.number().int(),
  }),
  counters: z.record(z.number()),
});

const COUNTERS = [
  "notifications_created",
  "deliveries_sent",
  "deliveries_failed",
  "deliveries_sent_email",
  "deliveries_sent_push",
  "deliveries_failed_email",
  "deliveries_failed_push",
  "push_subscriptions_expired",
];

export const adminNotificationRoutes: FastifyPluginAsyncZod<{
  prisma: PrismaClient;
  redis: Redis;
  redisPrefix: string;
}> = async (app, { prisma, redis, redisPrefix }) => {
  app.addHook("preHandler", app.requireAdmin);
  app.get(
    "/",
    {
      schema: {
        tags: ["admin"],
        summary: "Notification delivery health (aggregates only)",
        security,
        querystring: z
          .object({ hours: z.coerce.number().int().min(1).max(168).default(24) })
          .strict(),
        response: { 200: ok(notificationOverview) },
      },
    },
    async (req) => {
      const hours = req.query.hours;
      const now = Date.now();
      const since = new Date(now - hours * 3_600_000);
      const [byChannel, overdue, failures, byType, active, expired, revoked, summary] =
        await Promise.all([
          prisma.notificationDelivery.groupBy({
            by: ["channel", "status"],
            where: { createdAt: { gte: since } },
            _count: { _all: true },
          }),
          prisma.notificationDelivery.count({
            where: { status: "PENDING", scheduledAt: { lt: new Date(now - 10 * 60_000) } },
          }),
          prisma.notificationDelivery.groupBy({
            by: ["channel", "lastError"],
            where: { status: "FAILED", updatedAt: { gte: since } },
            _count: { _all: true },
            orderBy: { _count: { id: "desc" } },
            take: 10,
          }),
          prisma.notification.groupBy({
            by: ["type"],
            where: { createdAt: { gte: since } },
            _count: { _all: true },
          }),
          prisma.pushSubscription.count({ where: { revokedAt: null, expiredAt: null } }),
          prisma.pushSubscription.count({ where: { expiredAt: { not: null } } }),
          prisma.pushSubscription.count({ where: { revokedAt: { not: null }, expiredAt: null } }),
          readTrackingSummary(redis, redisPrefix, hours).catch(() => ({ counters: {} })),
        ]);
      const deliveries: Record<string, Record<string, number>> = {};
      for (const r of byChannel) (deliveries[r.channel] ??= {})[r.status] = r._count._all;
      const counters: Record<string, number> = {};
      for (const k of COUNTERS) {
        const v = (summary.counters as Record<string, number>)[k];
        if (typeof v === "number") counters[k] = v;
      }
      return {
        hours,
        deliveries,
        overduePending: overdue,
        topFailures: failures.map((f) => ({
          channel: f.channel,
          // Stored errors are short, content-free provider messages.
          reason: (f.lastError ?? "unknown").slice(0, 200),
          count: f._count._all,
        })),
        notificationsByType: Object.fromEntries(byType.map((t) => [t.type, t._count._all])),
        pushSubscriptions: { active, expired, revoked },
        counters,
      };
    },
  );
};
