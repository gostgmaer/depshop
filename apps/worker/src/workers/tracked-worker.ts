/**
 * Shared BullMQ worker setup for the tracking pipeline:
 *  - payload validation (an invalid payload is unrecoverable: dead-lettered);
 *  - processors return an action: "delay" moves the job back without using an
 *    attempt (DealMind's own rate limit), "retry" fails the attempt so BullMQ
 *    retries it with exponential backoff + full jitter;
 *  - jobs that exhaust their attempts go to the dead-letter queue;
 *  - stalled jobs (worker crash) are re-queued by BullMQ's stalled checker;
 *  - queue delay (enqueue → start) is recorded for monitoring.
 */
import { DEFAULT_JOB_OPTIONS, JITTER_BACKOFF, QueueName, jitterBackoff } from "@dealmind/queue";
import {
  type ConnectionOptions,
  DelayedError,
  type Job,
  type Queue,
  UnrecoverableError,
  Worker,
} from "bullmq";
import type { Logger } from "pino";
import type { z } from "zod";
import type { TrackingMetrics } from "../services/tracking-metrics.js";

export type ProcessorAction =
  | { action: "done" }
  | { action: "delay"; ms: number; reason: string }
  | { action: "retry"; reason: string };

export interface TrackedWorkerOptions<T> {
  queue: string;
  schema: z.ZodType<T>;
  connection: ConnectionOptions;
  prefix: string;
  concurrency: number;
  backoff: { baseMs: number; capMs: number };
  deadLetter: Pick<Queue, "add">;
  metrics: TrackingMetrics;
  log: Logger;
  /** Upper bound of one job's run time; the lock is renewed while it runs. */
  lockDurationMs?: number;
  process: (
    data: T,
    ctx: { attempt: number; maxAttempts: number; job: Job },
  ) => Promise<ProcessorAction>;
  /** Called once a job is dead-lettered (e.g. mark its delivery FAILED). */
  onDeadLetter?: (data: T, reason: string) => Promise<void>;
  random?: () => number;
}

export function createTrackedWorker<T>(o: TrackedWorkerOptions<T>): Worker {
  const worker = new Worker(
    o.queue,
    async (job: Job, token?: string) => {
      if (job.processedOn && job.attemptsMade === 0)
        await o.metrics.inc({
          queue_delay_ms_sum: Math.max(
            0,
            job.processedOn - (job.delay ? job.timestamp + job.delay : job.timestamp),
          ),
          queue_delay_count: 1,
        });
      const parsed = o.schema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError(`Invalid payload: ${parsed.error.message}`);
      const maxAttempts = job.opts.attempts ?? 1;
      const r = await o.process(parsed.data, { attempt: job.attemptsMade + 1, maxAttempts, job });
      if (r.action === "delay") {
        await job.moveToDelayed(Date.now() + r.ms, token);
        throw new DelayedError();
      }
      if (r.action === "retry") throw new Error(r.reason);
      return r;
    },
    {
      connection: o.connection,
      prefix: o.prefix,
      concurrency: o.concurrency,
      lockDuration: o.lockDurationMs ?? 120_000,
      // A job whose worker died is re-queued once its lock expires, at most twice.
      stalledInterval: 30_000,
      maxStalledCount: 2,
      settings: {
        backoffStrategy: (attemptsMade: number, type?: string) =>
          type === JITTER_BACKOFF
            ? jitterBackoff(attemptsMade, o.backoff.baseMs, o.backoff.capMs, o.random)
            : DEFAULT_JOB_OPTIONS.backoff.delay * 2 ** Math.max(0, attemptsMade - 1),
      },
    },
  );
  worker.on("failed", (job, err) => {
    if (!job) return;
    const max = job.opts.attempts ?? 1;
    const final =
      job.attemptsMade >= max ||
      err instanceof UnrecoverableError ||
      err.name === "UnrecoverableError";
    o.log[final ? "error" : "warn"](
      { queue: o.queue, jobId: job.id, attempt: job.attemptsMade, err: err.message },
      final ? "job dead-lettered" : "job attempt failed; will retry",
    );
    if (!final) return;
    void (async () => {
      try {
        await o.deadLetter.add(
          QueueName.deadLetter,
          {
            queue: o.queue,
            jobId: String(job.id),
            name: job.name,
            data: job.data as unknown,
            failedReason: err.message.slice(0, 2000),
            attemptsMade: job.attemptsMade,
            failedAt: new Date().toISOString(),
          },
          {
            jobId: `dead.${o.queue}.${String(job.id)}.${job.attemptsMade}`,
            removeOnComplete: false,
          },
        );
        await o.metrics.inc({ jobs_dead_lettered: 1 });
        const parsed = o.schema.safeParse(job.data);
        if (parsed.success && o.onDeadLetter) await o.onDeadLetter(parsed.data, err.message);
      } catch (e) {
        o.log.error(
          { queue: o.queue, jobId: job.id, err: (e as Error).message },
          "dead-letter write failed",
        );
      }
    })();
  });
  worker.on("error", (err) => o.log.error({ queue: o.queue, err: err.message }, "worker error"));
  return worker;
}
