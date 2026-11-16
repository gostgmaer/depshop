/**
 * DealMind background worker.
 *  - shopping-search: supervises the Python LangGraph agent (apps/agent),
 *    which orchestrates each search through the API's internal endpoints;
 *  - connector-health: scheduled health checks of every registered connector;
 *  - global price tracking (Phase 5.1): scheduler → price-refresh (one job per
 *    marketplace offer, shared by all users) → alert-evaluation (each user's
 *    alerts) → notification-delivery (shared notification service), plus
 *    hourly cleanup and a dead-letter queue. See docs/TRACKING.md.
 */
import {
  HealthMonitor,
  PrismaSourceConfigProvider,
  PrismaSourceStatusStore,
  ProductLookupExecutor,
  RedisMetricsStore,
  RedisRateLimiter,
  createDefaultRegistry,
} from "@dealmind/connectors";
import { NotificationClient } from "@easydev_org/notification-sdk";
import { createPrismaClient } from "@dealmind/db";
import { QueueName, redisConnectionFromUrl } from "@dealmind/queue";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { z } from "zod";
import { AgentClient } from "./agent-client.js";
import { processShoppingSearch } from "./search-processor.js";
import { TrackingMetrics } from "./services/tracking-metrics.js";
import { startTrackingWorkers } from "./workers/tracking-workers.js";

const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9:_-]{1,40}$/)
      .default("dm"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    CONNECTOR_HEALTH_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
    /** Mock connectors (fictional data) — default on outside production; refused in production. */
    CONNECTORS_ENABLE_MOCKS: z.enum(["true", "false"]).optional(),
    FLIPKART_AFFILIATE_ID: z.string().optional(),
    FLIPKART_AFFILIATE_TOKEN: z.string().optional(),
    AMAZON_CREATORS_CREDENTIAL_ID: z.string().optional(),
    AMAZON_CREATORS_CREDENTIAL_SECRET: z.string().optional(),
    AMAZON_ASSOCIATES_PARTNER_TAG: z.string().optional(),
    /** Python agent service (internal network only). */
    AGENT_SERVICE_URL: z.string().url(),
    AGENT_SERVICE_TOKEN: z.string().min(32),
    AGENT_USER_CONTEXT_SECRET: z.string().min(32),
    AGENT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(180),
    LOG_LEVEL: z.string().default("info"),
    // ── Global price tracking ──
    TRACKING_ENABLED: z.enum(["true", "false"]).default("true"),
    TRACKING_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
    TRACKING_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
    TRACKING_MAX_QUEUED: z.coerce.number().int().min(10).max(100_000).default(2_000),
    /** Share of each source's per-minute budget background tracking may use. */
    TRACKING_SOURCE_SHARE: z.coerce.number().min(0.05).max(1).default(0.5),
    TRACKING_HIGH_DEMAND_MIN: z.coerce.number().int().min(1).max(10_000).default(3),
    PRICE_TRACKING_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
    ALERT_EVALUATION_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
    NOTIFICATION_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
    /** Shared EasyDev notification service (email). Unset: email deliveries are SKIPPED. */
    NOTIFICATION_SERVICE_URL: z.string().url().optional(),
    NOTIFICATION_API_KEY: z.string().optional(),
    NOTIFICATION_TENANT_ID: z.string().default("dealmind"),
    APP_URL: z.string().url().default("http://localhost:3100"),
  })
  .parse(process.env);

const allowMocks = env.CONNECTORS_ENABLE_MOCKS
  ? env.CONNECTORS_ENABLE_MOCKS === "true"
  : env.NODE_ENV !== "production";
if (allowMocks && env.NODE_ENV === "production")
  throw new Error("Mock connectors are not allowed in production");

const log = pino({
  level: env.LOG_LEVEL,
  base: { service: "dealmind-worker" },
  // Credentials and signed contexts are never logged, even by accident.
  redact: [
    "*.token",
    "*.FLIPKART_AFFILIATE_TOKEN",
    "*.AMAZON_CREATORS_CREDENTIAL_SECRET",
    "*.AGENT_SERVICE_TOKEN",
    "*.AGENT_USER_CONTEXT_SECRET",
    "*.NOTIFICATION_API_KEY",
    "*.apiKey",
    "*.userContext",
    "headers",
  ],
});
const prisma = createPrismaClient({ url: env.DATABASE_URL });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const prefix = env.REDIS_KEY_PREFIX;

const registry = createDefaultRegistry(env, { includeMocks: allowMocks });
const sources = new PrismaSourceConfigProvider(prisma);
const statusStore = new PrismaSourceStatusStore(prisma);
const monitor = new HealthMonitor(registry, sources, statusStore);
const agent = new AgentClient(env.AGENT_SERVICE_URL, env.AGENT_SERVICE_TOKEN);

const connection = redisConnectionFromUrl(env.REDIS_URL);
const bullPrefix = `${prefix}:bull`;

const searchWorker = new Worker(
  QueueName.shoppingSearch,
  async (job) => {
    const outcome = await processShoppingSearch(
      {
        prisma,
        agent,
        redis,
        redisPrefix: prefix,
        userContextSecret: env.AGENT_USER_CONTEXT_SECRET,
        timeoutMs: env.AGENT_TIMEOUT_SECONDS * 1000,
      },
      job.data,
      { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 },
    );
    log.info({ jobId: job.id, outcome }, "shopping search processed");
    return outcome;
  },
  {
    connection,
    prefix: bullPrefix,
    concurrency: env.WORKER_CONCURRENCY,
    // A search can legitimately run for minutes; keep the job lock alive.
    lockDuration: Math.max(60_000, env.AGENT_TIMEOUT_SECONDS * 1000),
  },
);

const healthQueue = new Queue(QueueName.connectorHealth, { connection, prefix: bullPrefix });
await healthQueue.upsertJobScheduler(
  "connector-health",
  { every: env.CONNECTOR_HEALTH_INTERVAL_SECONDS * 1000 },
  { name: "check", data: {} },
);
const healthWorker = new Worker(
  QueueName.connectorHealth,
  async () => {
    const reports = await monitor.checkAll();
    log.info(
      { reports: reports.map((r) => ({ id: r.sourceId, health: r.health })) },
      "connector health checked",
    );
    return reports.length;
  },
  { connection, prefix: bullPrefix, concurrency: 1 },
);

// ── Global price tracking ──
const trackingQueues = {
  priceRefresh: new Queue(QueueName.priceRefresh, { connection, prefix: bullPrefix }),
  alertEvaluation: new Queue(QueueName.alertEvaluation, { connection, prefix: bullPrefix }),
  notification: new Queue(QueueName.notificationDelivery, { connection, prefix: bullPrefix }),
  deadLetter: new Queue(QueueName.deadLetter, { connection, prefix: bullPrefix }),
};
const controlQueue = new Queue(QueueName.trackingControl, { connection, prefix: bullPrefix });
const trackingWorkers: Worker[] = [];
if (env.TRACKING_ENABLED === "true") {
  const onRedisError = (err: unknown) =>
    log.warn({ err: (err as Error).message }, "redis unavailable for tracking bookkeeping");
  const lookup = new ProductLookupExecutor({
    registry,
    sources,
    rateLimiter: new RedisRateLimiter(redis, prefix, onRedisError),
    metrics: new RedisMetricsStore(redis, prefix, onRedisError),
    allowMocks,
    trackingShare: env.TRACKING_SOURCE_SHARE,
  });
  const notificationClient = env.NOTIFICATION_SERVICE_URL
    ? new NotificationClient({
        baseUrl: env.NOTIFICATION_SERVICE_URL,
        tenantId: env.NOTIFICATION_TENANT_ID,
        timeout: 10_000,
        ...(env.NOTIFICATION_API_KEY ? { apiKey: env.NOTIFICATION_API_KEY } : {}),
      })
    : null;
  trackingWorkers.push(
    ...startTrackingWorkers({
      prisma,
      redis,
      redisPrefix: prefix,
      connection,
      bullPrefix,
      lookup,
      metrics: new TrackingMetrics(redis, prefix),
      log,
      queues: trackingQueues,
      email: notificationClient,
      appUrl: env.APP_URL,
      policy: {
        highDemandMin: env.TRACKING_HIGH_DEMAND_MIN,
        maxBackoffMinutes: 24 * 60,
        jitterShare: 0.1,
      },
      concurrency: {
        refresh: env.PRICE_TRACKING_CONCURRENCY,
        alerts: env.ALERT_EVALUATION_CONCURRENCY,
        notifications: env.NOTIFICATION_CONCURRENCY,
      },
      scheduler: { batchSize: env.TRACKING_BATCH_SIZE, maxQueued: env.TRACKING_MAX_QUEUED },
    }),
  );
  // Repeatable control jobs (BullMQ job schedulers: one per id, cluster-wide).
  await controlQueue.upsertJobScheduler(
    "tracking-schedule",
    { every: env.TRACKING_SCHEDULER_INTERVAL_SECONDS * 1000 },
    { name: "schedule", data: { task: "schedule" } },
  );
  await controlQueue.upsertJobScheduler(
    "tracking-cleanup",
    { every: 3_600_000 },
    { name: "cleanup", data: { task: "cleanup" } },
  );
  if (!notificationClient)
    log.warn("NOTIFICATION_SERVICE_URL is not set: alert emails will be recorded as SKIPPED");
} else {
  await controlQueue.removeJobScheduler("tracking-schedule");
  await controlQueue.removeJobScheduler("tracking-cleanup");
  log.warn("price tracking disabled (TRACKING_ENABLED=false)");
}

for (const w of [searchWorker, healthWorker]) {
  w.on("failed", (job, err) =>
    log.error({ queue: w.name, jobId: job?.id, err: err.message }, "job failed"),
  );
}
log.info(
  {
    queues: [
      QueueName.shoppingSearch,
      QueueName.connectorHealth,
      ...trackingWorkers.map((w) => w.name),
    ],
    connectors: registry
      .list()
      .map((c) => ({ id: c.id, mock: c.isMock, readiness: c.getReadiness().state })),
  },
  "worker started",
);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  // Workers finish their active jobs before closing (BullMQ graceful close).
  await Promise.all([
    searchWorker.close(),
    healthWorker.close(),
    ...trackingWorkers.map((w) => w.close()),
  ]);
  await Promise.all([
    healthQueue.close(),
    controlQueue.close(),
    ...Object.values(trackingQueues).map((q) => q.close()),
  ]);
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
