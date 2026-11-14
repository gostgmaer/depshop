/**
 * Liveness:  GET /health  (alias /health/live)  — process is up; no dependency checks.
 * Readiness: GET /ready   (alias /health/ready) — critical dependencies reachable.
 * Responses name checks only ("ok"/"fail"); no configuration or error details.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

export type HealthCheck = () => Promise<void>;

const readiness = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.record(z.enum(["ok", "fail"])),
  optional: z.record(z.enum(["ok", "fail"])),
});

export interface HealthRoutesOptions {
  /** Failing any of these makes the API not ready (503). */
  checks: Record<string, HealthCheck>;
  /** Reported only; never affect readiness. */
  optionalChecks?: Record<string, HealthCheck>;
  /** Per-check timeout so one hung dependency cannot hang the probe. */
  checkTimeoutMs?: number;
}

function withTimeout(check: HealthCheck, ms: number): Promise<void> {
  return Promise.race([
    check(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("health check timed out")), ms).unref(),
    ),
  ]);
}

export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (
  app,
  { checks, optionalChecks = {}, checkTimeoutMs = 3_000 },
) => {
  const run = async (group: Record<string, HealthCheck>, log: (obj: object, msg: string) => void) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(group).map(async ([name, check]) => {
          try {
            await withTimeout(check, checkTimeoutMs);
            return [name, "ok"] as const;
          } catch (err) {
            log({ err: (err as Error).message, check: name }, "Readiness check failed");
            return [name, "fail"] as const;
          }
        }),
      ),
    );

  const live = {
    schema: { tags: ["health"], response: { 200: z.object({ status: z.literal("ok") }) } },
    config: { rateLimit: false as const },
  };
  for (const path of ["/health", "/health/live"])
    app.get(path, live, () => ({ status: "ok" as const }));

  for (const path of ["/ready", "/health/ready"]) {
    app.get(
      path,
      {
        schema: { tags: ["health"], response: { 200: readiness, 503: readiness } },
        config: { rateLimit: false as const },
      },
      async (req, reply) => {
        const log = req.log.warn.bind(req.log);
        const [critical, optional] = await Promise.all([
          run(checks, log),
          run(optionalChecks, log),
        ]);
        const healthy = Object.values(critical).every((v) => v === "ok");
        return reply
          .status(healthy ? 200 : 503)
          .send({ status: healthy ? "ok" : "degraded", checks: critical, optional });
      },
    );
  }
};
