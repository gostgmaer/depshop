/**
 * Internal pricing & ranking API (/internal/v1/intelligence/pricing|ranking):
 * real app, PostgreSQL and Redis. Fictional "Acme" offers from a mock source;
 * bank/membership names are eligibility labels only.
 */
import { randomUUID } from "node:crypto";
import type { SourceListing } from "@dealmind/catalog";
import { seedMockSources } from "@dealmind/connectors";
import { seedReferenceData } from "@dealmind/db";
import { CatalogImporter } from "@dealmind/intelligence";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeIam } from "./fake-iam.js";
import { type TestContext, createTestApp, truncateAll } from "./harness.js";

const TOKEN = "i".repeat(40);
const SOURCE = "mock_alpha";
const DAY = 86_400_000;
let ctx: TestContext;
let seq = 0;
type Json = Record<string, unknown>;

const bankOffer = {
  type: "BANK_OFFER",
  description: "₹1,500 off with HDFC Bank credit cards",
  amountPaise: 150_000,
  eligibleBanks: ["HDFC Bank"],
  cardTypes: ["CREDIT"],
  verified: true,
};

function listing(over: Partial<SourceListing> = {}): SourceListing {
  seq += 1;
  return {
    externalId: `p-${seq}`,
    title: "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
    productUrl: `https://mock-alpha.example.com/p/${seq}`,
    brand: "Acme",
    categorySlug: "smartphones",
    sellingPricePaise: 2_499_900,
    mrpPaise: 2_999_900,
    shippingPaise: 0,
    stockStatus: "IN_STOCK",
    ...over,
  };
}

beforeAll(async () => {
  const iam = await FakeIam.create();
  ctx = await createTestApp(
    { INTERNAL_API_TOKEN: TOKEN, AGENT_USER_CONTEXT_SECRET: "c".repeat(40) },
    { fetch: (url: string | URL | Request, init?: RequestInit) => iam.fetch(url, init) },
    iam,
  );
});
afterAll(() => ctx.close());

let offers: { cheap: string; bank: string; out: string };
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await seedMockSources(ctx.prisma, "test");
  const s = await new CatalogImporter(ctx.prisma).importListings(SOURCE, [
    listing({ sellingPricePaise: 2_449_900, shippingPaise: 4_000, externalId: "cheap" }),
    listing({ offerConditions: { bankOffers: [bankOffer] }, externalId: "bank" }),
    listing({ sellingPricePaise: 1_999_900, stockStatus: "OUT_OF_STOCK", externalId: "out" }),
  ]);
  const id = (index: number) => {
    const o = s.outcomes.find((x) => x.index === index);
    if (o?.status !== "imported") throw new Error(`listing ${index} not imported`);
    return o.offerId;
  };
  offers = { cheap: id(0), bank: id(1), out: id(2) };
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url: `/internal/v1${url}`,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

describe("pricing endpoints", () => {
  it("require the service token", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/v1/intelligence/pricing/calculate",
      payload: { offerId: offers.cheap },
    });
    expect(res.statusCode).toBe(401);
  });

  it("calculate one offer from the database; 404 for unknown offers", async () => {
    const res = await call("POST", "/intelligence/pricing/calculate", { offerId: offers.cheap });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ offer: Json }>().offer).toMatchObject({
      offerId: offers.cheap,
      isSample: true,
      pricing: {
        prices: { basePaise: 2_449_900, shippingPaise: 4_000, deliveredPaise: 2_453_900 },
        directDiscount: { status: "OK", amountPaise: 550_000, percentBp: 1_833 },
        assessment: { verdict: "INSUFFICIENT_HISTORY" },
      },
    });
    expect(
      (await call("POST", "/intelligence/pricing/calculate", { offerId: randomUUID() })).statusCode,
    ).toBe(404);
  });

  it("apply a bank offer only for a user who stated an eligible bank and card", async () => {
    const batch = async (eligibility?: Json) =>
      (
        await call("POST", "/intelligence/pricing/batch", {
          offerIds: [offers.bank, randomUUID()],
          ...(eligibility ? { eligibility } : {}),
        })
      ).json<{
        offers: { pricing: { prices: Json; benefits: Json[] } }[];
        unknownOfferIds: string[];
      }>();
    const unknown = await batch();
    expect(unknown.unknownOfferIds).toHaveLength(1);
    expect(unknown.offers[0]!.pricing.prices).toMatchObject({
      bankOfferPricePaise: null,
      bestVerifiedPayablePaise: 2_499_900,
    });
    expect(unknown.offers[0]!.pricing.benefits[0]).toMatchObject({ status: "UNVERIFIED" });
    const eligible = await batch({ banks: ["HDFC"], cardTypes: ["CREDIT"] });
    expect(eligible.offers[0]!.pricing.prices).toMatchObject({
      bankOfferPricePaise: 2_349_900,
      bestVerifiedPayablePaise: 2_349_900,
      deliveredPaise: 2_499_900,
    });
    expect(
      (await batch({ banks: ["SBI"], cardTypes: ["CREDIT"] })).offers[0]!.pricing.benefits[0],
    ).toMatchObject({
      status: "INELIGIBLE",
    });
  });

  it("returns history analytics with honest lowest-price wording", async () => {
    const now = Date.now();
    await ctx.prisma.priceSnapshot.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        offerId: offers.cheap,
        sellingPricePaise: 2_699_900n,
        mrpPaise: 2_999_900n,
        stockStatus: "IN_STOCK" as const,
        observedAt: new Date(now - (100 - i) * DAY),
      })),
    });
    const res = await call("GET", `/intelligence/pricing/history/${offers.cheap}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ stats: Json; series: Json[] }>();
    expect(body.stats).toMatchObject({
      lowestClaim: {
        kind: "LOWEST_IN_WINDOW",
        days: 90,
        text: "Lowest observed price in the last 90 days",
      },
      previousPricePaise: 2_699_900,
    });
    expect(body.series.length).toBeGreaterThanOrEqual(100);
    expect((await call("GET", `/intelligence/pricing/history/${randomUUID()}`)).statusCode).toBe(
      404,
    );
    expect(
      (await call("GET", `/intelligence/pricing/history/${offers.cheap}?days=500`)).statusCode,
    ).toBe(422);
  });
});

describe("ranking endpoints", () => {
  it("rank with hard filters, exclusions, explanations and a signed token", async () => {
    const res = await call("POST", "/intelligence/ranking/rank", {
      mode: "lowest_price",
      offerIds: [offers.bank, offers.cheap, offers.out],
      filters: { maxPricePaise: 2_500_000 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      ranked: (Json & { offer: Json; explanation: { versusNext: string } })[];
      excluded: Json[];
      rankingToken: string;
    }>();
    expect(body.ranked.map((d) => d.offerId)).toEqual([offers.cheap, offers.bank]);
    expect(body.ranked[0]).toMatchObject({
      rank: 1,
      deliveredPricePaise: 2_453_900,
      offer: { offerId: offers.cheap, productName: "Acme Nova 7 5G" },
    });
    expect(body.ranked[0]!.explanation.versusNext).toContain("₹460 lower delivered price");
    expect(body.excluded).toEqual([{ offerId: offers.out, reason: "UNAVAILABLE" }]);
    expect(body.rankingToken.split(".")).toHaveLength(2);
  });

  it("rank by verified payable price only with stated eligibility", async () => {
    const order = async (eligibility?: Json) =>
      (
        await call("POST", "/intelligence/ranking/rank", {
          mode: "lowest_price",
          priceBasis: "best_verified",
          offerIds: [offers.cheap, offers.bank],
          ...(eligibility ? { eligibility } : {}),
        })
      )
        .json<{ ranked: { offerId: string }[] }>()
        .ranked.map((d) => d.offerId);
    expect(await order()).toEqual([offers.cheap, offers.bank]);
    expect(await order({ banks: ["HDFC Bank"], cardTypes: ["CREDIT"] })).toEqual([
      offers.bank,
      offers.cheap,
    ]);
  });

  it("compare offers side by side", async () => {
    const res = await call("POST", "/intelligence/ranking/compare", {
      offerIds: [offers.cheap, offers.bank, offers.out],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      cheapestDelivered: offers.cheap,
      highestDirectDiscount: offers.cheap,
      sameVariant: true,
    });
    expect(
      (await call("POST", "/intelligence/ranking/compare", { offerIds: [offers.cheap] }))
        .statusCode,
    ).toBe(422);
  });

  it("reject unknown modes and stray fields", async () => {
    for (const body of [
      { mode: "most_commission", offerIds: [offers.cheap] },
      { mode: "best_value", offerIds: [offers.cheap], affiliateBoost: 1 },
      { mode: "best_value", offerIds: [offers.cheap], weights: { affiliate: 50 } },
    ]) {
      expect((await call("POST", "/intelligence/ranking/rank", body)).statusCode).toBe(422);
    }
  });
});
