import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

export type HealthCheck = () => Promise<void>;

const readiness = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.record(z.enum(["ok", "fail"])),
});

export const healthRoutes: FastifyPluginAsyncZod<{ checks: Record<string, HealthCheck> }> = async (
  app,
  { checks },
) => {
  app.get(
    "/live",
    { schema: { tags: ["health"], response: { 200: z.object({ status: z.literal("ok") }) } } },
    () => ({ status: "ok" as const }),
  );

  app.get(
    "/ready",
    { schema: { tags: ["health"], response: { 200: readiness, 503: readiness } } },
    async (req, reply) => {
      const entries = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
          try {
            await check();
            return [name, "ok"] as const;
          } catch (err) {
            req.log.warn({ err, check: name }, "Readiness check failed");
            return [name, "fail"] as const;
          }
        }),
      );
      const results = Object.fromEntries(entries);
      const healthy = entries.every(([, v]) => v === "ok");
      return reply
        .status(healthy ? 200 : 503)
        .send({ status: healthy ? "ok" : "degraded", checks: results });
    },
  );
};
