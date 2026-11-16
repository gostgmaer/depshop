/**
 * Phase 5.2 API: watchlists (prices, marketplace, 7-day movement), alert
 * lifecycle with validated transitions, history, and cross-user access on
 * every endpoint. Fictional "Acme" listings from mock sources.
 */
import type { SourceListing } from "@dealmind/catalog";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { CatalogImporter } from "@dealmind/intelligence";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Agent,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  truncateAll,
} from "./harness.js";

const DAY = 86_400_000;
let ctx: TestContext;
let variantId: string;
let offerId: string;
let alphaId: string;

const listing = (over: Partial<SourceListing> = {}): SourceListing => ({
  externalId: "aw-1",
  title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
  productUrl: "https://mock-alpha.example.com/p/aw-1",
  brand: "Acme",
  categorySlug: "smartphones",
  sellingPricePaise: 3_100_000,
  mrpPaise: 3_499_900,
  shippingPaise: 0,
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
  alphaId = (await ctx.prisma.shoppingSource.findUniqueOrThrow({ where: { slug: "mock_alpha" } }))
    .id;
});

const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
type Alert = {
  id: string;
  status: string;
  type: string;
  repeat: boolean;
  channels: string[];
  expiresAt: string | null;
  triggerCount: number;
  current: { deliveredPaise: number; marketplace: { slug: string } } | null;
  progressBp: number | null;
  baselinePricePaise: number | null;
  minChangePaise: number | null;
};

describe("watchlists", () => {
  it("creates named lists, renames, adds once, removes, and shows prices with 7-day movement", async () => {
    const { agent } = await signUp(ctx, "wl@example.com");
    const phones = data<{ id: string }>(
      await agent.post("/api/v1/watchlists", { name: "Smartphones to Buy" }),
    );
    expect(
      (await agent.post("/api/v1/watchlists", { name: "Smartphones to Buy" })).statusCode,
    ).toBe(409);
    const second = await agent.post("/api/v1/watchlists", { name: "Laptop Research" });
    expect(second.statusCode).toBe(201);
    // Renaming onto another list's name is refused too.
    expect(
      (await agent.patch(`/api/v1/watchlists/${phones.id}`, { name: "Laptop Research" }))
        .statusCode,
    ).toBe(409);
    const renamed = await agent.patch(`/api/v1/watchlists/${phones.id}`, { name: "Phones" });
    expect(data<{ name: string }>(renamed).name).toBe("Phones");

    expect(
      (await agent.post(`/api/v1/watchlists/${phones.id}/items`, { variantId })).statusCode,
    ).toBe(201);
    // Duplicate product in the same list.
    expect(
      (await agent.post(`/api/v1/watchlists/${phones.id}/items`, { variantId })).statusCode,
    ).toBe(409);

    // History: the price was ₹32,000 7½ days ago (now ₹31,000).
    await ctx.prisma.priceSnapshot.create({
      data: {
        offerId,
        sellingPricePaise: 3_200_000n,
        shippingPaise: 0n,
        stockStatus: "IN_STOCK",
        observedAt: new Date(Date.now() - 7.5 * DAY),
      },
    });
    const detail = data<{
      items: {
        id: string;
        lowestPricePaise: number;
        current: { deliveredPaise: number; marketplace: { slug: string }; offerCount: number };
        movement: { previousPaise: number; changePaise: number; changeBp: number } | null;
      }[];
    }>(await agent.get(`/api/v1/watchlists/${phones.id}`));
    expect(detail.items[0]).toMatchObject({
      lowestPricePaise: 3_100_000,
      current: { deliveredPaise: 3_100_000, marketplace: { slug: "mock_alpha" }, offerCount: 1 },
      movement: { previousPaise: 3_200_000, changePaise: -100_000, changeBp: -312 },
    });

    const itemId = detail.items[0]!.id;
    expect((await agent.delete(`/api/v1/watchlists/${phones.id}/items/${itemId}`)).statusCode).toBe(
      204,
    );
    expect(
      data<{ items: unknown[] }>(await agent.get(`/api/v1/watchlists/${phones.id}`)).items,
    ).toEqual([]);
  });

  it("shows no movement when nothing was observed 7 days ago (never estimated)", async () => {
    const { agent } = await signUp(ctx, "wl2@example.com");
    const w = data<{ id: string }>(await agent.post("/api/v1/watchlists", { name: "Upcoming" }));
    await agent.post(`/api/v1/watchlists/${w.id}/items`, { variantId });
    const detail = data<{ items: { movement: unknown }[] }>(
      await agent.get(`/api/v1/watchlists/${w.id}`),
    );
    expect(detail.items[0]!.movement).toBeNull();
  });
});

describe("alert lifecycle", () => {
  it("creates with options, reports current price and progress, and validates every transition", async () => {
    const { agent } = await signUp(ctx, "life@example.com");
    const expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
    const res = await agent.post("/api/v1/alerts", {
      variantId,
      type: "TARGET_PRICE",
      targetPricePaise: 3_000_000,
      channels: ["IN_APP"],
      expiresAt,
      sourceId: alphaId,
    });
    expect(res.statusCode, res.body).toBe(201);
    const a = data<Alert>(res);
    expect(a).toMatchObject({
      status: "ACTIVE",
      repeat: false,
      channels: ["IN_APP"],
      baselinePricePaise: 3_100_000,
      current: { deliveredPaise: 3_100_000, marketplace: { slug: "mock_alpha" } },
      progressBp: 0,
    });
    // The price moves halfway from ₹31,000 toward ₹30,000.
    await ctx.prisma.productOffer.update({
      where: { id: offerId },
      data: { sellingPricePaise: 3_050_000n },
    });
    expect(data<Alert>(await agent.get(`/api/v1/alerts/${a.id}`)).progressBp).toBe(5_000);

    const act = (action: string) => agent.post(`/api/v1/alerts/${a.id}/${action}`, {});
    expect((await act("resume")).statusCode).toBe(200); // already active: idempotent
    expect(data<Alert>(await act("pause")).status).toBe("PAUSED");
    expect((await act("pause")).statusCode).toBe(200); // idempotent
    expect(data<Alert>(await act("resume")).status).toBe("ACTIVE");

    // The worker marked it TRIGGERED: it can be re-armed or cancelled, not paused.
    await ctx.prisma.priceAlert.update({ where: { id: a.id }, data: { status: "TRIGGERED" } });
    expect((await act("pause")).statusCode).toBe(409);
    const patched = await agent.patch(`/api/v1/alerts/${a.id}`, {
      targetPricePaise: 2_900_000,
      repeat: true,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(data<Alert>(await act("resume")).status).toBe("ACTIVE");

    expect(data<Alert>(await act("cancel")).status).toBe("CANCELLED");
    expect((await act("cancel")).statusCode).toBe(200); // idempotent
    for (const action of ["pause", "resume"]) expect((await act(action)).statusCode).toBe(409);
    expect((await agent.patch(`/api/v1/alerts/${a.id}`, { cooldownMinutes: 10 })).statusCode).toBe(
      409,
    );

    // Expired alerts are final too.
    const b = data<Alert>(await agent.post("/api/v1/alerts", { variantId, type: "BACK_IN_STOCK" }));
    await ctx.prisma.priceAlert.update({ where: { id: b.id }, data: { status: "EXPIRED" } });
    expect((await agent.post(`/api/v1/alerts/${b.id}/resume`, {})).statusCode).toBe(409);
    expect((await agent.delete(`/api/v1/alerts/${b.id}`)).statusCode).toBe(204);
  });

  it("validates conditions and their parameters on create and update", async () => {
    const { agent } = await signUp(ctx, "cond@example.com");
    const create = (b: object) => agent.post("/api/v1/alerts", { variantId, ...b });
    const drop = await create({ type: "PRICE_DROP", sourceId: alphaId, minChangePaise: 50_000 });
    expect(data<Alert>(drop)).toMatchObject({ type: "PRICE_DROP", minChangePaise: 50_000 });
    expect(
      (await create({ type: "TARGET_PRICE", targetPricePaise: 1, minChangePaise: 5 })).statusCode,
    ).toBe(422);
    expect((await create({ type: "PRICE_DROP", channels: [] })).statusCode).toBe(422);
    const id = data<Alert>(drop).id;
    expect((await agent.patch(`/api/v1/alerts/${id}`, { targetPricePaise: 100 })).statusCode).toBe(
      422,
    );
    expect(
      data<Alert>(await agent.patch(`/api/v1/alerts/${id}`, { minChangePaise: null }))
        .minChangePaise,
    ).toBeNull();
  });

  it("lists history and previous triggers", async () => {
    const { agent, userId } = await signUp(ctx, "hist@example.com");
    const a = data<Alert>(
      await agent.post("/api/v1/alerts", { variantId, targetPricePaise: 3_200_000 }),
    );
    for (const outcome of ["NOT_MET", "TRIGGERED"] as const)
      await ctx.prisma.alertEvaluation.create({
        data: {
          userId,
          alertId: a.id,
          offerId,
          outcome,
          observedPricePaise: 3_100_000n,
          reason: outcome,
        },
      });
    const all = data<unknown[]>(await agent.get(`/api/v1/alerts/${a.id}/history`));
    const triggers = data<{ outcome: string }[]>(
      await agent.get(`/api/v1/alerts/${a.id}/history?outcome=TRIGGERED`),
    );
    expect(all).toHaveLength(2);
    expect(triggers.map((t) => t.outcome)).toEqual(["TRIGGERED"]);
  });
});

describe("cross-user access (IDOR)", () => {
  it("never lets another user read or change a watchlist or alert", async () => {
    const owner = await signUp(ctx, "owner@example.com");
    const other = await signUp(ctx, "other@example.com");
    const w = data<{ id: string }>(await owner.agent.post("/api/v1/watchlists", { name: "Mine" }));
    const detail = data<{ items: { id: string }[] }>(
      await owner.agent.post(`/api/v1/watchlists/${w.id}/items`, { variantId }),
    );
    const itemId = detail.items[0]!.id;
    const a = data<Alert>(
      await owner.agent.post("/api/v1/alerts", { variantId, targetPricePaise: 3_000_000 }),
    );

    const o: Agent = other.agent;
    const attempts = [
      o.get(`/api/v1/watchlists/${w.id}`),
      o.patch(`/api/v1/watchlists/${w.id}`, { name: "Stolen" }),
      o.post(`/api/v1/watchlists/${w.id}/items`, { variantId }),
      o.delete(`/api/v1/watchlists/${w.id}/items/${itemId}`),
      o.delete(`/api/v1/watchlists/${w.id}`),
      o.get(`/api/v1/alerts/${a.id}`),
      o.patch(`/api/v1/alerts/${a.id}`, { targetPricePaise: 1 }),
      o.post(`/api/v1/alerts/${a.id}/pause`, {}),
      o.post(`/api/v1/alerts/${a.id}/resume`, {}),
      o.post(`/api/v1/alerts/${a.id}/cancel`, {}),
      o.get(`/api/v1/alerts/${a.id}/history`),
      o.delete(`/api/v1/alerts/${a.id}`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(404);
    expect(data<unknown[]>(await o.get("/api/v1/alerts"))).toEqual([]);
    expect(data<unknown[]>(await o.get("/api/v1/watchlists"))).toEqual([]);
    // Nothing changed for the owner.
    expect(
      data<{ name: string; items: unknown[] }>(await owner.agent.get(`/api/v1/watchlists/${w.id}`)),
    ).toMatchObject({
      name: "Mine",
      items: [expect.anything()],
    });
    expect(data<Alert>(await owner.agent.get(`/api/v1/alerts/${a.id}`)).status).toBe("ACTIVE");
  });
});
