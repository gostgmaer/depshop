/**
 * Global price-tracking operations (ADMIN only): queue depths, dead letters,
 * worker counters (last N hours, written by apps/worker) and database
 * aggregates. Global data only — no user's alert or notification contents.
 */
import type { PrismaClient } from "@dealmind/db";
import { type JobQueues, QueueName, readTrackingSummary } from "@dealmind/queue";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z } from "zod";
import { ok } from "../../utils/http.js";

const security = [{ sessionCookie: [] }];
const TRACKING_QUEUES = [
  QueueName.trackingControl,
  QueueName.priceRefresh,
  QueueName.alertEvaluation,
  QueueName.notificationDelivery,
  QueueName.deadLetter,
] as const;

const counts = z.record(z.number().int());
export const trackingOverview = z.object({
  hours: z.number().int(),
  queues: z.record(counts),
  counters: z.record(z.number()),
  averageQueueDelayMs: z.number().int().nullable(),
  sources: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      status: z.string(),
      trackingEnabled: z.boolean(),
      intervalsMinutes: z.object({ high: z.number(), normal: z.number(), low: z.number() }),
      lookups: z.number().int(),
      averageLatencyMs: z.number().int().nullable(),
    }),
  ),
  offers: z.object({ byState: counts, dueNow: z.number().int() }),
  checks: z.object({ byOutcome: counts }),
  alertEvaluations: z.object({ byOutcome: counts }),
  deliveries: z.object({ byStatus: counts }),
  recentDeadLetters: z.array(
    z.object({
      queue: z.string(),
      jobId: z.string(),
      failedReason: z.string(),
      attemptsMade: z.number().int(),
      failedAt: z.string(),
    }),
  ),
});

export const adminTrackingRoutes: FastifyPluginAsyncZod<{
  prisma: PrismaClient;
  redis: Redis;
  redisPrefix: string;
  jobs: JobQueues;
}> = async (app, { prisma, redis, redisPrefix, jobs }) => {
  app.addHook("preHandler", app.requireAdmin);

  app.get(
    "/tracking",
    {
      schema: {
        tags: ["admin"],
        summary: "Global price tracking: queues, dead letters, counters and outcomes",
        security,
        querystring: z
          .object({ hours: z.coerce.number().int().min(1).max(168).default(24) })
          .strict(),
        response: { 200: ok(trackingOverview) },
      },
    },
    async (req) => {
      const hours = req.query.hours;
      const since = new Date(Date.now() - hours * 3_600_000);
      const group = <T extends { _count: { _all: number } }>(rows: T[], key: keyof T) =>
        Object.fromEntries(rows.map((r) => [String(r[key]), r._count._all]));
      const [queueCounts, summary, sources, byState, dueNow, checks, evals, deliveries, dead] =
        await Promise.all([
          Promise.all(
            TRACKING_QUEUES.map(async (q): Promise<[string, Record<string, number>]> => [
              q,
              await jobs
                .queue(q)
                .getJobCounts("waiting", "prioritized", "active", "delayed", "completed", "failed"),
            ]),
          ),
          readTrackingSummary(redis, redisPrefix, hours),
          prisma.shoppingSource.findMany({ orderBy: { name: "asc" } }),
          prisma.productOffer.groupBy({ by: ["trackingState"], _count: { _all: true } }),
          prisma.productOffer.count({
            where: {
              trackingState: { in: ["ACTIVE", "MISSING"] },
              OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
              source: { status: "ACTIVE", trackingEnabled: true },
            },
          }),
          prisma.priceCheck.groupBy({
            by: ["outcome"],
            where: { checkedAt: { gte: since } },
            _count: { _all: true },
          }),
          prisma.alertEvaluation.groupBy({
            by: ["outcome"],
            where: { evaluatedAt: { gte: since } },
            _count: { _all: true },
          }),
          prisma.notificationDelivery.groupBy({
            by: ["status"],
            where: { createdAt: { gte: since } },
            _count: { _all: true },
          }),
          jobs.queue(QueueName.deadLetter).getJobs(["waiting", "completed"], 0, 19),
        ]);
      return {
        hours,
        queues: Object.fromEntries(queueCounts),
        counters: summary.counters,
        averageQueueDelayMs: summary.averageQueueDelayMs,
        sources: sources.map((s) => ({
          slug: s.slug,
          name: s.name,
          status: s.status,
          trackingEnabled: s.trackingEnabled,
          intervalsMinutes: {
            high: s.trackingHighMinutes,
            normal: s.trackingNormalMinutes,
            low: s.trackingLowMinutes,
          },
          lookups: summary.sources[s.slug]?.lookups ?? 0,
          averageLatencyMs: summary.sources[s.slug]?.averageLatencyMs ?? null,
        })),
        offers: { byState: group(byState, "trackingState"), dueNow },
        checks: { byOutcome: group(checks, "outcome") },
        alertEvaluations: { byOutcome: group(evals, "outcome") },
        deliveries: { byStatus: group(deliveries, "status") },
        recentDeadLetters: dead.map((j) => {
          const d = j.data as {
            queue?: string;
            jobId?: string;
            failedReason?: string;
            attemptsMade?: number;
            failedAt?: string;
          };
          return {
            queue: d.queue ?? "",
            jobId: d.jobId ?? String(j.id),
            failedReason: (d.failedReason ?? "").slice(0, 500),
            attemptsMade: d.attemptsMade ?? 0,
            failedAt: d.failedAt ?? new Date(j.timestamp).toISOString(),
          };
        }),
      };
    },
  );
};
