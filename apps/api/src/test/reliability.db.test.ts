/**
 * Phase 7.1 reliability: behaviour while PostgreSQL or Redis is unavailable,
 * and recovery when it returns (no restart needed).
 */
import { createPrismaClient } from "@dealmind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestContext, createTestApp } from "./harness.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp(
    {},
    {
      healthChecks: {
        database: async () => {
          await ctx.prisma.$queryRaw`SELECT 1`;
        },
      },
    },
  );
});
afterAll(() => ctx.close());

describe("database outage", () => {
  it("answers 503 with a safe message and reports not-ready", async () => {
    // Nothing listens on port 1: every query fails like a database outage.
    const down = createPrismaClient({ url: "postgresql://x:y@127.0.0.1:1/none?connect_timeout=1" });
    const outage = await createTestApp(
      {},
      {
        prisma: down,
        healthChecks: {
          database: async () => {
            await down.$queryRaw`SELECT 1`;
          },
        },
      },
    );
    try {
      const ready = await outage.app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ status: "degraded", checks: { database: "fail" } });
      const res = await outage.app.inject({ method: "GET", url: "/api/v1/categories/tree" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(res.body).not.toMatch(/127\.0\.0\.1|postgresql|prisma|P10\d\d/i);
      // Liveness stays OK: the orchestrator must not restart-loop the API for a DB outage.
      expect((await outage.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(
        200,
      );
    } finally {
      await outage.close().catch(() => undefined);
    }
  });
});

describe("redis outage and recovery", () => {
  it("reports not-ready while Redis is down and recovers by itself when it returns", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    // disconnect() closes the socket asynchronously: wait until the client has ended.
    const ended = new Promise((r) => ctx.redis.once("end", r));
    ctx.redis.disconnect();
    await ended;
    const during = await ctx.app.inject({ method: "GET", url: "/ready" });
    expect(during.statusCode).toBe(503);
    expect(during.json()).toMatchObject({ checks: { redis: "fail" } });
    // Liveness unaffected; DB-backed public reads keep working (rate limiting fails open).
    expect((await ctx.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    await ctx.redis.connect();
    const deadline = Date.now() + 10_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await ctx.app.inject({ method: "GET", url: "/ready" })).statusCode;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toBe(200);
  });
});
