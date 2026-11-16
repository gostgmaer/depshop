import { type ConnectionOptions, type JobsOptions, Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS, JOBS, type JobPayloads, QueueName } from "./jobs.js";

export interface JobQueuesOptions {
  connection: ConnectionOptions;
  /** BullMQ key prefix, e.g. "dm:bull". Tests use a unique prefix per run. */
  prefix: string;
}

/**
 * Producer side of the job contracts. Validates payloads before enqueueing
 * and always uses the deterministic jobId (idempotent enqueue).
 */
export class JobQueues {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly opts: JobQueuesOptions) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.opts.connection,
        prefix: this.opts.prefix,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Enqueues a job; returns its id. Re-enqueueing the same payload is a no-op. */
  async enqueue<N extends QueueName>(
    name: N,
    payload: JobPayloads[N],
    opts: JobsOptions = {},
  ): Promise<string> {
    const spec = JOBS[name];
    const data = spec.schema.parse(payload);
    const jobId = (spec.jobId as (p: JobPayloads[N]) => string)(data as JobPayloads[N]);
    await this.queue(name).add(name, data, { ...opts, jobId });
    return jobId;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}

export { QueueName };
