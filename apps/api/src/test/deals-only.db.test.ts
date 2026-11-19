/**
 * Deals-only mode (the default: LIVE_SEARCH_ENABLED=false): shoppers search the stored deals;
 * submitting a live marketplace search is refused before anything is created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  truncateAll,
} from "./harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp({ LIVE_SEARCH_ENABLED: "false" });
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
});

describe("deals-only mode", () => {
  it("refuses a live search without creating a guest, a search or a job", async () => {
    const agent = new Agent(ctx.app);
    const res = await agent.post("/api/v1/search", { query: "acme nova phone" });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/deals/i);
    expect(agent.cookie("dm_guest")).toBeUndefined();
    expect(await ctx.prisma.user.count()).toBe(0);
    expect(await ctx.prisma.search.count()).toBe(0);
  });

  it("the deals list and its search stay public", async () => {
    const res = await new Agent(ctx.app).get("/api/v1/deals?q=phone");
    expect(res.statusCode).toBe(200);
    const policy = await new Agent(ctx.app).get("/api/v1/deals/policy");
    expect(policy.json<{ data: unknown }>().data).toEqual({
      minDiscountPercent: 20,
      liveSearch: false,
    });
  });
});
