/**
 * DealMind background worker. Consumes the shopping-search queue.
 * Price refresh, alert evaluation and notification delivery consumers arrive
 * with their phases (connectors, alerts, notifications); their jobs are not
 * consumed yet and stay queued.
 */
import { createPrismaClient } from "@dealmind/db";
import { QueueName, redisConnectionFromUrl } from "@dealmind/queue";
import { Worker } from "bullmq";
import { pino } from "pino";
import { z } from "zod";
import { processShoppingSearch } from "./search-processor.js";

const env = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9:_-]{1,40}$/)
      .default("dm"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { service: "dealmind-worker" } });
const prisma = createPrismaClient({ url: env.DATABASE_URL });

const searchWorker = new Worker(
  QueueName.shoppingSearch,
  async (job) => {
    const outcome = await processShoppingSearch(prisma, job.data);
    log.info({ jobId: job.id, outcome }, "shopping search processed");
    return outcome;
  },
  {
    connection: redisConnectionFromUrl(env.REDIS_URL),
    prefix: `${env.REDIS_KEY_PREFIX}:bull`,
    concurrency: env.WORKER_CONCURRENCY,
  },
);
searchWorker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, err: err.message }, "job failed"),
);
log.info({ queues: [QueueName.shoppingSearch] }, "worker started");

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  await searchWorker.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
