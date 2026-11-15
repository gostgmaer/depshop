/**
 * DealMind background worker.
 *  - shopping-search: supervises the Python LangGraph agent (apps/agent),
 *    which orchestrates each search through the API's internal endpoints;
 *  - connector-health: scheduled health checks of every registered connector.
 * Price refresh, alert evaluation and notification delivery consumers arrive
 * with their phases; those jobs are not consumed yet.
 */
import {
  HealthMonitor,
  PrismaSourceConfigProvider,
  PrismaSourceStatusStore,
  createDefaultRegistry,
} from "@dealmind/connectors";
import { createPrismaClient } from "@dealmind/db";
import { QueueName, redisConnectionFromUrl } from "@dealmind/queue";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { z } from "zod";
import { AgentClient } from "./agent-client.js";
import { processShoppingSearch } from "./search-processor.js";

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

for (const w of [searchWorker, healthWorker]) {
  w.on("failed", (job, err) =>
    log.error({ queue: w.name, jobId: job?.id, err: err.message }, "job failed"),
  );
}
log.info(
  {
    queues: [QueueName.shoppingSearch, QueueName.connectorHealth],
    connectors: registry
      .list()
      .map((c) => ({ id: c.id, mock: c.isMock, readiness: c.getReadiness().state })),
  },
  "worker started",
);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  await Promise.all([searchWorker.close(), healthWorker.close(), healthQueue.close()]);
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
