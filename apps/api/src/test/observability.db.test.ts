/** Phase 7.1 observability: metrics endpoint protection/content and request correlation. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestContext, createTestApp, signUp, truncateAll } from "./harness.js";

const TOKEN = "m".repeat(40);
let ctx: TestContext;
let plain: TestContext;
beforeAll(async () => {
  ctx = await createTestApp({ METRICS_TOKEN: TOKEN });
  plain = await createTestApp();
  await truncateAll(ctx.prisma);
});
afterAll(async () => {
  await ctx.close();
  await plain.close();
});

describe("metrics", () => {
  it("doesn't exist unless configured, and needs the token", async () => {
    expect((await plain.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const wrong = await ctx.app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${"x".repeat(40)}` },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("labels by route template only: no ids, query text or emails", async () => {
    const { agent } = await signUp(ctx, `m-${randomUUID().slice(0, 6)}@example.com`);
    const id = randomUUID();
    await agent.get(`/api/v1/searches/${id}`);
    await agent.get(`/api/v1/search/${id}`);
    await agent.get("/api/v1/categories/tree?q=my+private+query");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain('route="/api/v1/search/:id"');
    expect(res.body).toContain("dealmind_http_request_duration_seconds_bucket");
    expect(res.body).toMatch(/dealmind_queue_jobs\{queue="[a-z-]+",state="waiting"\} \d+/);
    expect(res.body).not.toContain(id);
    expect(res.body).not.toContain("private");
    expect(res.body).not.toContain("@example.com");
  });
});

describe("request correlation", () => {
  it("echoes a well-formed upstream request id and replaces a malformed one", async () => {
    const good = await ctx.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "web-12345678" },
    });
    expect(good.headers["x-request-id"]).toBe("web-12345678");
    const bad = await ctx.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": 'evil"\n{json}' },
    });
    expect(bad.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
