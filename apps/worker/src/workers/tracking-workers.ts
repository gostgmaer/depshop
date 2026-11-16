/**
 * The tracking workers (price refresh → alert evaluation) and the control
 * worker that runs the scheduler and cleanup, plus the notification delivery
 * worker (started separately: it doesn't depend on tracking).
 * Each worker is independent: a failing marketplace only fails its own
 * refresh jobs, never other sources or other queues.
 */
import type { ProductLookupExecutor } from "@dealmind/connectors";
import type { EmailProvider, PushProvider } from "@dealmind/notifications";
import type { PrismaClient } from "@dealmind/db";
import {
  QueueName,
  alertEvaluationJob,
  notificationDeliveryJob,
  priceRefreshJob,
  trackingControlJob,
} from "@dealmind/queue";
import { type ConnectionOptions, type Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { TrackingPolicyConfig } from "../policies/tracking-policy.js";
import { processAlertEvaluation } from "../processors/alert-evaluation.processor.js";
import { processNotificationDelivery } from "../processors/notification.processor.js";
import { processPriceRefresh } from "../processors/price-refresh.processor.js";
import {
  ALERT_EVALUATION_BACKOFF,
  ALERT_EVALUATION_JOB_OPTIONS,
} from "../queues/alert-evaluation.queue.js";
import { NOTIFICATION_BACKOFF, NOTIFICATION_JOB_OPTIONS } from "../queues/notification.queue.js";
import { PRICE_REFRESH_BACKOFF } from "../queues/price-tracking.queue.js";
import { runCleanup } from "../schedulers/cleanup.scheduler.js";
import { scheduleDueOffers } from "../schedulers/tracking.scheduler.js";
import type { TrackingMetrics } from "../services/tracking-metrics.js";
import { createTrackedWorker } from "./tracked-worker.js";

export interface TrackingRuntime {
  prisma: PrismaClient;
  redis: Redis;
  redisPrefix: string;
  connection: ConnectionOptions;
  bullPrefix: string;
  lookup: ProductLookupExecutor;
  metrics: TrackingMetrics;
  log: Logger;
  queues: {
    priceRefresh: Queue;
    alertEvaluation: Queue;
    notification: Queue;
    deadLetter: Queue;
  };
  /** Email provider (shared notification service), or null: email deliveries are SKIPPED. */
  email: EmailProvider | null;
  /** Web push (VAPID), or null: push deliveries are SKIPPED. */
  push: PushProvider | null;
  /** Signs unsubscribe links in emails. */
  tokenSecret: string | null;
  appUrl: string;
  policy: TrackingPolicyConfig;
  concurrency: { refresh: number; alerts: number; notifications: number };
  scheduler: { batchSize: number; maxQueued: number };
}

export function enqueueAlertEvaluation(rt: Pick<TrackingRuntime, "queues">) {
  return async (checkId: string) => {
    await rt.queues.alertEvaluation.add(
      QueueName.alertEvaluation,
      { checkId },
      { ...ALERT_EVALUATION_JOB_OPTIONS, jobId: `alerts.${checkId}` },
    );
  };
}

export function enqueueDelivery(rt: { queues: Pick<TrackingRuntime["queues"], "notification"> }) {
  return async (deliveryId: string, notBefore?: Date) => {
    // Quiet hours: the job waits until the delivery is due.
    const delay = notBefore ? Math.max(0, notBefore.getTime() - Date.now()) : 0;
    await rt.queues.notification.add(
      QueueName.notificationDelivery,
      { deliveryId },
      { ...NOTIFICATION_JOB_OPTIONS, jobId: `delivery.${deliveryId}`, ...(delay ? { delay } : {}) },
    );
  };
}

const realtimeOf = (rt: Pick<TrackingRuntime, "redis" | "redisPrefix">) => ({
  redis: rt.redis,
  prefix: rt.redisPrefix,
});

export function startTrackingWorkers(rt: TrackingRuntime): Worker[] {
  const common = {
    connection: rt.connection,
    prefix: rt.bullPrefix,
    deadLetter: rt.queues.deadLetter,
    metrics: rt.metrics,
    log: rt.log,
  };
  const refresh = createTrackedWorker({
    ...common,
    queue: QueueName.priceRefresh,
    schema: priceRefreshJob,
    concurrency: rt.concurrency.refresh,
    backoff: PRICE_REFRESH_BACKOFF,
    process: async (data, ctx) => {
      const r = await processPriceRefresh(
        {
          prisma: rt.prisma,
          lookup: rt.lookup,
          metrics: rt.metrics,
          enqueueAlertEvaluation: enqueueAlertEvaluation(rt),
          redis: rt.redis,
          redisPrefix: rt.redisPrefix,
          policy: rt.policy,
        },
        data,
        ctx,
      );
      if (r.action === "done")
        rt.log.debug(
          { offerId: data.offerId, outcome: r.outcome, changed: r.changed },
          "price refreshed",
        );
      return r;
    },
  });
  const alerts = createTrackedWorker({
    ...common,
    queue: QueueName.alertEvaluation,
    schema: alertEvaluationJob,
    concurrency: rt.concurrency.alerts,
    backoff: ALERT_EVALUATION_BACKOFF,
    process: async (data) => {
      const s = await processAlertEvaluation(
        {
          prisma: rt.prisma,
          metrics: rt.metrics,
          enqueueDelivery: enqueueDelivery(rt),
          realtime: realtimeOf(rt),
        },
        data,
      );
      if (s.evaluated || s.duplicates)
        rt.log.info({ checkId: data.checkId, ...s }, "alerts evaluated");
      return { action: "done" };
    },
  });
  // Scheduler and cleanup: one at a time, cluster-wide (single control queue).
  const control = new Worker(
    QueueName.trackingControl,
    async (job) => {
      const { task } = trackingControlJob.parse(job.data);
      if (task === "schedule") {
        const r = await scheduleDueOffers({
          prisma: rt.prisma,
          queue: rt.queues.priceRefresh,
          redis: rt.redis,
          redisPrefix: rt.redisPrefix,
          metrics: rt.metrics,
          capableSlugs: () => rt.lookup.lookupCapableSlugs(),
          policy: rt.policy,
          ...rt.scheduler,
        });
        if (r.enqueued || r.backpressure || r.duplicatesPrevented)
          rt.log.info(r, "tracking scheduled");
        return r;
      }
      const r = await runCleanup({
        prisma: rt.prisma,
        enqueueDelivery: enqueueDelivery(rt),
        realtime: realtimeOf(rt),
      });
      rt.log.info(r, "tracking cleanup");
      return r;
    },
    { connection: rt.connection, prefix: rt.bullPrefix, concurrency: 1 },
  );
  control.on("failed", (job, err) =>
    rt.log.error({ jobId: job?.id, err: err.message }, "tracking control job failed"),
  );
  return [refresh, alerts, control];
}

export type NotificationRuntime = Pick<
  TrackingRuntime,
  | "prisma"
  | "metrics"
  | "email"
  | "push"
  | "tokenSecret"
  | "appUrl"
  | "connection"
  | "bullPrefix"
  | "log"
> & { queues: Pick<TrackingRuntime["queues"], "deadLetter">; concurrency: number };

/**
 * Notification delivery (email + web push). Independent of price tracking:
 * account and search notifications are delivered even when tracking is off.
 */
export function startNotificationWorker(rt: NotificationRuntime): Worker {
  return createTrackedWorker({
    connection: rt.connection,
    prefix: rt.bullPrefix,
    deadLetter: rt.queues.deadLetter,
    metrics: rt.metrics,
    log: rt.log,
    queue: QueueName.notificationDelivery,
    schema: notificationDeliveryJob,
    concurrency: rt.concurrency,
    backoff: NOTIFICATION_BACKOFF,
    process: (data, ctx) =>
      processNotificationDelivery(
        {
          prisma: rt.prisma,
          metrics: rt.metrics,
          email: rt.email,
          push: rt.push,
          appUrl: rt.appUrl,
          tokenSecret: rt.tokenSecret,
        },
        data,
        ctx,
      ),
    onDeadLetter: async (data, reason) => {
      await rt.prisma.notificationDelivery.updateMany({
        where: { id: data.deliveryId, status: "PENDING" },
        data: { status: "FAILED", lastError: reason.slice(0, 500) },
      });
    },
  });
}
