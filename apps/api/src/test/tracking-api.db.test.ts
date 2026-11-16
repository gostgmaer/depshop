/**
 * Phase 5.1 API: alert types (validation, baseline), the owner's evaluation
 * history, and the admin-only tracking overview. Fictional "Acme" listings.
 */
import type { SourceListing } from "@dealmind/catalog";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { CatalogImporter } from "@dealmind/intelligence";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  truncateAll,
} from "./harness.js";

let ctx: TestContext;
let variantId: string;
let offerId: string;

const listing = (over: Partial<SourceListing> = {}): SourceListing => ({
  externalId: "trk-1",
  title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
  productUrl: "https://mock-alpha.example.com/p/trk-1",
  brand: "Acme",
  categorySlug: "smartphones",
  sellingPricePaise: 2_499_900,
  mrpPaise: 2_999_900,
  shippingPaise: 4_000,
  stockStatus: "IN_STOCK",
  ...over,
});

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
  const s = await new CatalogImporter(ctx.prisma).importListings("mock_alpha", [listing()]);
  const o = s.outcomes[0]!;
  if (o.status !== "imported") throw new Error("not imported");
  variantId = o.variantId;
  offerId = o.offerId;
});

type Alert = {
  id: string;
  type: string;
  targetPricePaise: number | null;
  dropPercentBp: number | null;
  baselinePricePaise: number | null;
  historicalWindowDays: number | null;
  cooldownMinutes: number;
};

describe("alert types", () => {
  it("creates each type with exactly its parameters (older clients still work)", async () => {
    const { agent } = await signUp(ctx, "types@example.com");
    const create = (body: object) => agent.post("/api/v1/alerts", { variantId, ...body });

    const legacy = await create({ targetPricePaise: 2_400_000 });
    expect(legacy.statusCode, legacy.body).toBe(201);
    expect(legacy.json<{ data: Alert }>().data).toMatchObject({
      type: "TARGET_PRICE",
      targetPricePaise: 2_400_000,
    });

    const drop = await create({ type: "PERCENT_DROP", dropPercent: 10, cooldownMinutes: 60 });
    expect(drop.json<{ data: Alert }>().data).toMatchObject({
      type: "PERCENT_DROP",
      dropPercentBp: 1000,
      // Baseline = current delivered price (₹24,999 + ₹40 shipping), never invented.
      baselinePricePaise: 2_503_900,
      cooldownMinutes: 60,
      targetPricePaise: null,
    });
    const low = await create({ type: "HISTORICAL_LOW" });
    expect(low.json<{ data: Alert }>().data).toMatchObject({ historicalWindowDays: 90 });
    expect((await create({ type: "BACK_IN_STOCK" })).statusCode).toBe(201);

    // Wrong or missing parameters are rejected.
    expect((await create({ type: "PERCENT_DROP" })).statusCode).toBe(422);
    expect((await create({ type: "BACK_IN_STOCK", targetPricePaise: 100 })).statusCode).toBe(422);
    expect((await create({ type: "PERCENT_DROP", dropPercent: 95 })).statusCode).toBe(422);
    // Same type twice for the same variant/source is a duplicate; another type is not.
    expect((await create({ type: "BACK_IN_STOCK" })).statusCode).toBe(409);

    const id = drop.json<{ data: Alert }>().data.id;
    expect((await agent.patch(`/api/v1/alerts/${id}`, { targetPricePaise: 100 })).statusCode).toBe(
      422,
    );
    const patched = await agent.patch(`/api/v1/alerts/${id}`, { dropPercent: 20 });
    expect(patched.json<{ data: Alert }>().data.dropPercentBp).toBe(2000);
  });

  it("shows evaluation history to the alert's owner only", async () => {
    const alice = await signUp(ctx, "eval-a@example.com");
    const bob = await signUp(ctx, "eval-b@example.com");
    const a = (
      await alice.agent.post("/api/v1/alerts", { variantId, targetPricePaise: 2_600_000 })
    ).json<{
      data: Alert;
    }>().data;
    const check = await ctx.prisma.priceCheck.create({
      data: {
        offerId,
        sourceId: (
          await ctx.prisma.shoppingSource.findUniqueOrThrow({ where: { slug: "mock_alpha" } })
        ).id,
        outcome: "PRICE_DECREASED",
        previousPricePaise: 2_599_900n,
        newPricePaise: 2_499_900n,
        changePaise: -100_000n,
        changeBp: -384,
      },
    });
    await ctx.prisma.alertEvaluation.create({
      data: {
        userId: alice.userId,
        alertId: a.id,
        checkId: check.id,
        offerId,
        outcome: "TRIGGERED",
        observedPricePaise: 2_503_900n,
        reason: "₹25,039 is at or below the target of ₹26,000.",
      },
    });
    const mine = await alice.agent.get(`/api/v1/alerts/${a.id}/evaluations`);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json<{ data: unknown[] }>().data).toEqual([
      expect.objectContaining({
        outcome: "TRIGGERED",
        observedPricePaise: 2_503_900,
        marketplace: { slug: "mock_alpha", name: expect.any(String) as unknown },
      }),
    ]);
    expect((await bob.agent.get(`/api/v1/alerts/${a.id}/evaluations`)).statusCode).toBe(404);
    expect((await bob.agent.get("/api/v1/alerts")).json<{ data: unknown[] }>().data).toEqual([]);
  });
});

describe("GET /api/v1/admin/tracking", () => {
  it("is admin-only and reports queues, counters and outcomes", async () => {
    const { agent: user } = await signUp(ctx, "plain@example.com");
    expect((await user.get("/api/v1/admin/tracking")).statusCode).toBe(403);
    const { agent: admin } = await signUp(ctx, "ops@example.com", { role: "ADMIN" });
    await ctx.redis.hincrby(
      `${ctx.prefix}:tracking:metrics:${new Date().toISOString().slice(0, 13)}`,
      "price_changes",
      3,
    );
    const res = await admin.get("/api/v1/admin/tracking?hours=1");
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<{
      data: {
        queues: Record<string, Record<string, number>>;
        counters: Record<string, number>;
        offers: { byState: Record<string, number>; dueNow: number };
        sources: { slug: string; intervalsMinutes: { high: number } }[];
      };
    }>().data;
    expect(Object.keys(d.queues)).toContain("price-refresh");
    expect(d.counters.price_changes).toBe(3);
    expect(d.offers.byState).toEqual({ ACTIVE: 1 });
    expect(d.offers.dueNow).toBe(1);
    expect(d.sources.find((s) => s.slug === "mock_alpha")?.intervalsMinutes.high).toBe(30);
  });
});
