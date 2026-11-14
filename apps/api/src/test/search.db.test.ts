/**
 * Search API: async enqueue into a REAL BullMQ queue on Redis (this caught a
 * job-id format bug that pure unit tests missed), ownership and results.
 */
import { JOBS, QueueName } from "@dealmind/queue";
import { seedReferenceData } from "@dealmind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type TestContext, createTestApp, signUp, truncateAll } from "./harness.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  ctx.iam.reset();
});

describe("POST /api/v1/search", () => {
  it("creates a PENDING search and enqueues exactly one job with the deterministic id", async () => {
    const { agent, userId } = await signUp(ctx, "searcher@example.com");
    const res = await agent.post("/api/v1/search", {
      query: "acme nova 5g",
      filters: { maxPricePaise: 2_000_000 },
    });
    expect(res.statusCode, res.body).toBe(202);
    const search = res.json<{ data: { id: string; status: string } }>().data;
    expect(search.status).toBe("PENDING");

    const jobId = JOBS[QueueName.shoppingSearch].jobId({ searchId: search.id, userId });
    const job = await ctx.jobs.queue(QueueName.shoppingSearch).getJob(jobId);
    expect(job?.data).toEqual({ searchId: search.id, userId });
    // Re-enqueueing the same logical job is a no-op (idempotent).
    await ctx.jobs.enqueue(QueueName.shoppingSearch, { searchId: search.id, userId });
    expect(await ctx.jobs.queue(QueueName.shoppingSearch).getJobCounts("waiting")).toMatchObject({
      waiting: 1,
    });
  });

  it("keeps searches private to their owner", async () => {
    const alice = await signUp(ctx, "alice@example.com");
    const bob = await signUp(ctx, "bob@example.com");
    const created = await alice.agent.post("/api/v1/search", { query: "zenith laptop" });
    const id = created.json<{ data: { id: string } }>().data.id;
    expect((await alice.agent.get(`/api/v1/search/${id}`)).statusCode).toBe(200);
    expect((await bob.agent.get(`/api/v1/search/${id}`)).statusCode).toBe(404);
    expect((await bob.agent.get(`/api/v1/search/${id}/sources`)).statusCode).toBe(404);
    const bobList = (await bob.agent.get("/api/v1/search")).json<{ data: unknown[] }>().data;
    expect(bobList).toEqual([]);
  });

  it("validates input and requires authentication", async () => {
    const { agent } = await signUp(ctx, "v@example.com");
    expect((await agent.post("/api/v1/search", { query: "x" })).statusCode).toBe(422);
    expect(
      (await agent.post("/api/v1/search", { query: "phone", userId: "spoof" })).statusCode,
    ).toBe(422);
    const anon = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/search",
      payload: { query: "phone" },
    });
    expect([401, 403]).toContain(anon.statusCode);
  });
});
