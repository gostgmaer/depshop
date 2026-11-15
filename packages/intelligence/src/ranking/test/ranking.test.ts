import { describe, expect, it } from "vitest";
import { NOW, candidate, daily, daysAgo, promo, rs } from "../../pricing/test/fixtures.js";
import { compareOffers, rankOffers } from "../engine.js";
import type { RankCandidate } from "../types.js";

const ids = (r: ReturnType<typeof rankOffers>) => r.ranked.map((d) => d.offerId);
const rank = (cs: RankCandidate[], o: Partial<Parameters<typeof rankOffers>[1]> = {}) =>
  rankOffers(cs, { mode: "best_value", now: NOW, ...o });

describe("13. lowest-price ranking", () => {
  it("orders by delivered price (shipping included) and explains the lead", () => {
    const a = candidate({
      id: "a0000000-0000-7000-8000-000000000001",
      source: "Store A",
      selling: rs(24_999),
    });
    const b = candidate({
      id: "b0000000-0000-7000-8000-000000000001",
      source: "Store B",
      selling: rs(24_499),
      shipping: rs(40),
    });
    const c = candidate({
      id: "c0000000-0000-7000-8000-000000000001",
      source: "Store C",
      selling: rs(24_799),
    });
    const r = rank([a, b, c], { mode: "lowest_price" });
    expect(ids(r)).toEqual([b.offerId, c.offerId, a.offerId]);
    expect(r.ranked[0]).toMatchObject({ rank: 1, deliveredPricePaise: rs(24_539), score: 10_000 });
    expect(r.ranked[0]!.explanation.versusNext).toBe(
      "₹260 lower delivered price than #2 (Store C)",
    );
    expect(r.ranked[2]!.explanation.versusNext).toBeNull();
    // Legacy alias.
    expect(ids(rank([a, b, c], { mode: "cheapest" }))).toEqual(ids(r));
  });

  it("ranks by the verified payable price only when asked, and only with verified eligible benefits", () => {
    const bank = {
      bankOffers: [
        promo({
          type: "BANK_OFFER",
          description: "₹2,000 off",
          amountPaise: rs(2_000),
          eligibleBanks: ["SBI"],
          verified: true,
        }),
      ],
    };
    const a = candidate({ selling: rs(24_999), conditions: bank }, { banks: ["SBI"] });
    const b = candidate({ selling: rs(23_999) });
    expect(ids(rank([a, b], { mode: "lowest_price" }))).toEqual([b.offerId, a.offerId]);
    expect(ids(rank([a, b], { mode: "lowest_price", priceBasis: "best_verified" }))).toEqual([
      a.offerId,
      b.offerId,
    ]);
    // Same offer, user's bank unknown → no benefit applied.
    const unknown = candidate({ selling: rs(24_999), conditions: bank });
    expect(ids(rank([unknown, b], { mode: "lowest_price", priceBasis: "best_verified" }))).toEqual([
      b.offerId,
      unknown.offerId,
    ]);
  });
});

describe("14. highest-discount ranking", () => {
  it("prefers verified direct discount % then amount; no-MRP offers last", () => {
    const deep = candidate({ selling: rs(19_999), mrp: rs(29_999) }); // 33.33%
    const mild = candidate({ selling: rs(26_999), mrp: rs(29_999) }); // 10%
    const noMrp = candidate({ selling: rs(18_999), mrp: null });
    const r = rank([mild, noMrp, deep], { mode: "highest_discount" });
    expect(ids(r)).toEqual([deep.offerId, mild.offerId, noMrp.offerId]);
    expect(r.ranked[0]!.explanation.summary).toContain("33.33% off MRP");
    expect(r.warnings.some((w) => w.startsWith("NO_VERIFIABLE_MRP"))).toBe(true);
  });

  it("discounts an MRP 'deal' that the price history contradicts", () => {
    // 40% off MRP, but it has sold at this price for 60 days: NOT_GENUINE → half score.
    const inflated = candidate({
      selling: rs(17_999),
      mrp: rs(29_999),
      snapshots: daily(rs(17_999), 60),
    });
    const real = candidate({
      selling: rs(19_999),
      mrp: rs(29_999),
      snapshots: daily(rs(24_999), 60),
    });
    expect(inflated.pricing.assessment.verdict).toBe("NOT_GENUINE");
    expect(real.pricing.assessment.verdict).toBe("GENUINE");
    expect(ids(rank([inflated, real], { mode: "highest_discount" }))[0]).toBe(real.offerId);
  });
});

describe("15. best-value ranking", () => {
  it("balances normalized components and uses only those with data", () => {
    const match = candidate({ selling: rs(24_999), attributes: { ram_gb: 12, storage_gb: 256 } });
    const cheap = candidate({ selling: rs(23_999), attributes: { ram_gb: 8, storage_gb: 128 } });
    const r = rank([cheap, match], {
      preferredSpecs: { ram_gb: 12, storage_gb: 256 },
      query: "acme nova",
    });
    const top = r.ranked[0]!;
    expect(top.offerId).toBe(match.offerId);
    expect(top.components.specMatch).toBe(10_000);
    // ₹1,000 above the cheapest (4.16%) → 10000 − 4 × 416 = 8336.
    expect(top.components.price).toBe(8_336);
    expect(top.components.quality).toBeNull();
    expect(r.warnings).toContain("QUALITY_DATA_UNAVAILABLE: quality weight not used");
    for (const d of r.ranked) {
      expect(Number.isInteger(d.score)).toBe(true);
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(10_000);
    }
    expect(r.weights).toMatchObject({
      price: 35,
      specMatch: 20,
      discount: 15,
      history: 15,
      relevance: 15,
    });
    // Without spec preferences the cheaper offer wins.
    expect(ids(rank([cheap, match]))[0]).toBe(cheap.offerId);
  });

  it("applies hard filters before ranking and reports every exclusion", () => {
    const ok = candidate({ selling: rs(24_999) });
    const pricey = candidate({ selling: rs(31_999), mrp: rs(34_999) });
    const other = candidate({ brand: "Zenta" });
    const spec = candidate({ attributes: { ram_gb: 6 } });
    const unstated = candidate({ attributes: {} });
    const cat = candidate({ category: ["laptops", "electronics"] });
    const r = rank([ok, pricey, other, spec, unstated, cat], {
      filters: {
        maxPricePaise: rs(30_000),
        brands: ["ACME"],
        requiredSpecs: { ram_gb: 8 },
        categorySlugs: ["mobiles"],
      },
    });
    expect(ids(r)).toEqual([ok.offerId]);
    expect(Object.fromEntries(r.excluded.map((e) => [e.offerId, e.reason]))).toEqual({
      [pricey.offerId]: "ABOVE_MAX_PRICE",
      [other.offerId]: "BRAND_NOT_REQUESTED",
      [spec.offerId]: "SPEC_MISMATCH",
      [unstated.offerId]: "SPEC_NOT_STATED",
      [cat.offerId]: "CATEGORY",
    });
    const excludedProduct = rank([ok], { filters: { excludedProductIds: [ok.productId] } });
    expect(excludedProduct.excluded[0]!.reason).toBe("PRODUCT_EXCLUDED");
  });

  it("trending falls back to best value with a warning (no popularity data is invented)", () => {
    const r = rank([candidate(), candidate()], { mode: "trending_deals" });
    expect(r.appliedMode).toBe("best_value");
    expect(r.warnings[0]).toMatch(/^TRENDING_DATA_UNAVAILABLE/);
  });
});

describe("16. recently-launched ranking", () => {
  it("prefers recent launches, balanced with price; unknown launch dates last", () => {
    const fresh = candidate({ launchDate: daysAgo(20), selling: rs(27_999) });
    const old = candidate({ launchDate: daysAgo(400), selling: rs(19_999) });
    const unknown = candidate({ launchDate: null, selling: rs(17_999) });
    const r = rank([unknown, old, fresh], { mode: "recently_launched" });
    expect(ids(r)).toEqual([fresh.offerId, old.offerId, unknown.offerId]);
    expect(r.ranked[2]!.components.recency).toBeNull();
    expect(r.warnings.some((w) => w.startsWith("LAUNCH_DATE_UNKNOWN"))).toBe(true);
    expect(ids(rank([unknown, old, fresh], { mode: "newest" }))).toEqual(ids(r));
  });
});

describe("price-drop ranking", () => {
  it("ranks verified recent reductions first", () => {
    const dropped = candidate({ selling: rs(24_999), snapshots: daily(rs(27_999), 20, 3) });
    const flat = candidate({ selling: rs(22_999), snapshots: daily(rs(22_999), 20, 3) });
    const r = rank([flat, dropped], { mode: "price_drop" });
    expect(ids(r)).toEqual([dropped.offerId, flat.offerId]);
    expect(r.ranked[0]!.explanation.summary).toMatch(/^Dropped 10\.71% on /);
    expect(r.ranked[1]!.components.priceDrop).toBeNull();
  });
});

describe("17. unavailable product exclusion", () => {
  it("never ranks out-of-stock, stale or indicative offers; unconfirmed stock ranks after confirmed", () => {
    const inStock = candidate({ selling: rs(25_999) });
    const out = candidate({ selling: rs(19_999), stock: "OUT_OF_STOCK" });
    const stale = candidate({ selling: rs(18_999), observedAt: daysAgo(3) });
    const indicative = candidate({ selling: rs(17_999), conditions: { priceType: "INDICATIVE" } });
    const pre = candidate({ selling: rs(20_999), stock: "PREORDER" });
    const r = rank([out, stale, indicative, pre, inStock], { mode: "lowest_price" });
    expect(ids(r)).toEqual([inStock.offerId, pre.offerId]);
    expect(r.ranked[1]).toMatchObject({ availabilityConfirmed: false });
    expect(r.ranked[1]!.explanation.factors).toContain(
      "Pre-order: not available to buy immediately",
    );
    expect(Object.fromEntries(r.excluded.map((e) => [e.offerId, e.reason]))).toEqual({
      [out.offerId]: "UNAVAILABLE",
      [stale.offerId]: "STALE_PRICE",
      [indicative.offerId]: "INDICATIVE_PRICE",
    });
  });
});

describe("18. affiliate-neutral ranking", () => {
  it("ignores any affiliate/commission data attached to candidates", () => {
    const a = candidate({ id: "a1000000-0000-7000-8000-000000000001", selling: rs(24_999) });
    const b = candidate({ id: "b1000000-0000-7000-8000-000000000001", selling: rs(24_999) });
    const withAffiliate = (c: RankCandidate, bp: number) =>
      ({
        ...c,
        affiliate: { enabled: true, commissionBp: bp },
        sourceAffiliateEnabled: true,
      }) as RankCandidate;
    for (const mode of [
      "best_value",
      "lowest_price",
      "highest_discount",
      "recently_launched",
      "price_drop",
    ] as const) {
      const plain = rank([a, b], { mode });
      const paidA = rank([withAffiliate(a, 1_000), b], { mode });
      const paidB = rank([a, withAffiliate(b, 1_000)], { mode });
      const view = (r: typeof plain) => r.ranked.map((d) => [d.offerId, d.score]);
      expect(view(paidA)).toEqual(view(plain));
      expect(view(paidB)).toEqual(view(plain));
    }
  });
});

describe("explainable results and comparison", () => {
  it("exposes every required field with data-derived explanations", () => {
    const c = candidate({
      selling: rs(24_999),
      mrp: rs(29_999),
      snapshots: daily(rs(26_999), 100),
      conditions: {
        cashback: [
          promo({
            type: "CASHBACK",
            description: "₹500 cashback",
            amountPaise: rs(500),
            verified: true,
          }),
        ],
      },
    });
    const d = rank([c]).ranked[0]!;
    expect(d).toMatchObject({
      rank: 1,
      offerId: c.offerId,
      productId: c.productId,
      variantId: c.variantId,
      marketplace: { slug: "mock_alpha" },
      sellingPricePaise: rs(24_999),
      deliveredPricePaise: rs(24_999),
      directDiscount: { amountPaise: rs(5_000), percentBp: 1_666 },
      historicalContext: { lowestClaim: { kind: "LOWEST_IN_WINDOW", days: 90 } },
      priceObservedAt: NOW.toISOString(),
    });
    expect(d.conditionalBenefits).toHaveLength(1);
    expect(d.explanation.factors).toEqual(
      expect.arrayContaining([
        "Delivered price ₹24,999 (selling ₹24,999, free shipping)",
        "16.66% off MRP ₹29,999 (₹5,000)",
        "Lowest observed price in the last 90 days",
        "Cashback ₹500 (verified; credited later, not deducted from the price)",
      ]),
    );
  });

  it("is deterministic", () => {
    const cs = [
      candidate(),
      candidate({ selling: rs(23_999) }),
      candidate({ selling: rs(23_999) }),
    ];
    expect(rank(cs)).toEqual(rank([...cs].reverse()));
  });

  it("compares offers side by side", () => {
    const v = "30000000-0000-7000-8000-000000000001";
    const a = candidate({ variantId: v, source: "Store A", selling: rs(24_999), shipping: rs(99) });
    const b = candidate({ variantId: v, source: "Store B", selling: rs(25_049) });
    const out = candidate({
      variantId: v,
      source: "Store C",
      selling: rs(19_999),
      stock: "OUT_OF_STOCK",
    });
    const cmp = compareOffers([a, b, out]);
    expect(cmp.cheapestDelivered).toBe(b.offerId);
    expect(cmp.sameVariant).toBe(true);
    expect(cmp.offers.find((o) => o.offerId === a.offerId)!.deliveredVsCheapestPaise).toBe(rs(49));
    expect(cmp.notes).toContain("Out-of-stock offers are shown but not chosen as best.");
    expect(compareOffers([a, candidate()]).sameVariant).toBe(false);
  });
});
