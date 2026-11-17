/**
 * Prometheus metrics (Phase 7.1, observability), dependency-free.
 *
 * GET /metrics (text exposition format), served only when METRICS_TOKEN is
 * set and only with `Authorization: Bearer <METRICS_TOKEN>` — never routed by
 * Traefik (it forwards /api only). Labels use the ROUTE TEMPLATE
 * (`/api/v1/search/:id`), never the raw URL, so no ids, queries or other
 * personal data reach the metrics store and cardinality stays bounded.
 *
 * - dealmind_http_requests_total{method,route,status}
 * - dealmind_http_request_duration_seconds{method,route} (histogram)
 * - dealmind_queue_jobs{queue,state} (gauge, read at scrape time)
 * - process resident memory, heap and uptime
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { JobQueues } from "@dealmind/queue";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

export class HttpMetrics {
  readonly requests = new Map<string, number>();
  readonly durations = new Map<string, Histogram>();

  observe(method: string, route: string, status: number, seconds: number): void {
    const rk = `${method}\u0000${route}\u0000${status}`;
    this.requests.set(rk, (this.requests.get(rk) ?? 0) + 1);
    const dk = `${method}\u0000${route}`;
    const h = this.durations.get(dk) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i]! += 1;
    });
    h.sum += seconds;
    h.count += 1;
    this.durations.set(dk, h);
  }
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function renderMetrics(
  m: HttpMetrics,
  queues: { queue: string; state: string; count: number }[],
): string {
  const out: string[] = [];
  out.push("# HELP dealmind_http_requests_total HTTP requests by route template and status.");
  out.push("# TYPE dealmind_http_requests_total counter");
  for (const [k, v] of m.requests) {
    const [method, route, status] = k.split("\u0000");
    out.push(
      `dealmind_http_requests_total{method="${esc(method!)}",route="${esc(route!)}",status="${status}"} ${v}`,
    );
  }
  out.push("# HELP dealmind_http_request_duration_seconds HTTP request latency.");
  out.push("# TYPE dealmind_http_request_duration_seconds histogram");
  for (const [k, h] of m.durations) {
    const [method, route] = k.split("\u0000");
    const l = `method="${esc(method!)}",route="${esc(route!)}"`;
    BUCKETS.forEach((b, i) =>
      out.push(`dealmind_http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`),
    );
    out.push(`dealmind_http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`);
    out.push(`dealmind_http_request_duration_seconds_sum{${l}} ${h.sum}`);
    out.push(`dealmind_http_request_duration_seconds_count{${l}} ${h.count}`);
  }
  out.push("# HELP dealmind_queue_jobs BullMQ jobs by queue and state (read at scrape time).");
  out.push("# TYPE dealmind_queue_jobs gauge");
  for (const q of queues)
    out.push(`dealmind_queue_jobs{queue="${esc(q.queue)}",state="${q.state}"} ${q.count}`);
  const mem = process.memoryUsage();
  out.push("# TYPE dealmind_process_resident_memory_bytes gauge");
  out.push(`dealmind_process_resident_memory_bytes ${mem.rss}`);
  out.push("# TYPE dealmind_process_heap_used_bytes gauge");
  out.push(`dealmind_process_heap_used_bytes ${mem.heapUsed}`);
  out.push("# TYPE dealmind_process_uptime_seconds gauge");
  out.push(`dealmind_process_uptime_seconds ${Math.round(process.uptime())}`);
  return `${out.join("\n")}\n`;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export const metricsPlugin = fp<{
  token: string | undefined;
  jobs: JobQueues;
  queueNames: string[];
}>(
  (app: FastifyInstance, { token, jobs, queueNames }, done) => {
    const metrics = new HttpMetrics();
    app.addHook("onResponse", async (request, reply) => {
      // Route template only (unmatched routes collapse into one label).
      const route = request.routeOptions.url ?? "unmatched";
      if (route === "/metrics") return;
      metrics.observe(request.method, route, reply.statusCode, reply.elapsedTime / 1000);
    });
    if (token) {
      app.get(
        "/metrics",
        { config: { rateLimit: false }, schema: { hide: true } },
        async (req, reply) => {
          const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
          if (!m || !timingSafeEqual(digest(m[1]!), digest(token)))
            return reply
              .status(401)
              .send({
                success: false,
                error: { code: "UNAUTHENTICATED", message: "Metrics token required" },
              });
          const queues = (
            await Promise.all(
              queueNames.map(async (name) => {
                const counts = await jobs
                  .queue(name as never)
                  .getJobCounts("waiting", "active", "delayed", "failed", "prioritized")
                  .catch(() => ({}));
                return Object.entries(counts).map(([state, count]) => ({
                  queue: name,
                  state,
                  count,
                }));
              }),
            )
          ).flat();
          return reply
            .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
            .header("cache-control", "no-store")
            .send(renderMetrics(metrics, queues));
        },
      );
    }
    done();
  },
  { name: "metrics" },
);
