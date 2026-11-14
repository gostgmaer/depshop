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
}

export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (
  app,
  { checks, optionalChecks = {} },
) => {
  const run = async (group: Record<string, HealthCheck>, log: (obj: object, msg: string) => void) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(group).map(async ([name, check]) => {
          try {
            await check();
            return [name, "ok"] as const;
          } catch (err) {
            log({ err, check: name }, "Readiness check failed");
            return [name, "fail"] as const;
          }
        }),
      ),
    );

  app.get(
    "/live",
    { schema: { tags: ["health"], response: { 200: z.object({ status: z.literal("ok") }) } } },
    () => ({ status: "ok" as const }),
  );

  app.get(
    "/ready",
    { schema: { tags: ["health"], response: { 200: readiness, 503: readiness } } },
    async (req, reply) => {
      const log = req.log.warn.bind(req.log);
      const [critical, optional] = await Promise.all([run(checks, log), run(optionalChecks, log)]);
      const healthy = Object.values(critical).every((v) => v === "ok");
      return reply
        .status(healthy ? 200 : 503)
        .send({ status: healthy ? "ok" : "degraded", checks: critical, optional });
    },
  );
};
