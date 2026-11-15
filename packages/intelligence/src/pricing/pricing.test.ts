import { describe, expect, it } from "vitest";
import { assessPrice, effectivePricePaise, medianPaise, type PricePoint } from "./pricing.js";
import { rankDeals, relevanceBp, type DealCandidate } from "../ranking/ranking.js";

const now = new Date("2026-11-15T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const history = (prices: number[], spanDays = 60): PricePoint[] =>
  prices.map((p, i) => ({
    sellingPricePaise: p,
    observedAt: daysAgo(spanDays - (i * spanDays) / Math.max(1, prices.length - 1)),
  }));

describe("pricing engine", () => {
  it("computes effective price (selling + shipping) and integer medians", () => {
    expect(effectivePricePaise(1_999_900, 4_000)).toBe(2_003_900);
    expect(effectivePricePaise(1_999_900, null)).toBe(1_999_900);
    expect(medianPaise([5, 1, 3, 2])).toBe(2);
    expect(medianPaise([])).toBeNull();
  });

  it("calls a discount GENUINE only when the price history supports it", () => {
    const h = history([2_100_000, 2_100_000, 2_050_000, 2_100_000, 2_080_000]);
    const a = assessPrice({ sellingPricePaise: 1_899_900, mrpPaise: 2_499_900 }, h, now);
    expect(a.verdict).toBe("GENUINE");
    expect(a.genuineDiscountBp).toBe(Math.floor(((2_100_000 - 1_899_900) * 10_000) / 2_100_000));
    expect(a.reasons).toContain("LOWEST_IN_WINDOW");
    expect(a.claimedDiscountBp).toBe(2_400);
  });

  it("flags an inflated-MRP 'discount' that matches the usual price as NOT_GENUINE", () => {
    const h = history([1_899_900, 1_899_900, 1_899_900, 1_949_900, 1_899_900]);
    const a = assessPrice({ sellingPricePaise: 1_899_900, mrpPaise: 3_999_900 }, h, now);
    expect(a.verdict).toBe("NOT_GENUINE");
    expect(a.reasons).toEqual(
      expect.arrayContaining([
        "AT_OR_ABOVE_TYPICAL_PRICE",
        "MRP_DISCOUNT_NOT_REFLECTED_IN_HISTORY",
      ]),
    );
    expect(a.claimedDiscountBp).toBeGreaterThan(5_000);
    expect(a.genuineDiscountBp).toBe(0);
  });

  it("refuses to judge without enough history (points or span), and ignores old points", () => {
    expect(assessPrice({ sellingPricePaise: 100 }, history([200, 200]), now).verdict).toBe(
      "INSUFFICIENT_HISTORY",
    );
    expect(
      assessPrice({ sellingPricePaise: 100 }, history([200, 200, 200, 200, 200], 5), now).verdict,
    ).toBe("INSUFFICIENT_HISTORY");
    const old = [200, 200, 200, 200, 200].map((p, i) => ({
      sellingPricePaise: p,
      observedAt: daysAgo(200 + i * 10),
    }));
    expect(assessPrice({ sellingPricePaise: 100 }, old, now).history.points).toBe(0);
    expect(assessPrice({ sellingPricePaise: 100, mrpPaise: null }, [], now).reasons).toContain(
      "NO_MRP",
    );
  });
});

function deal(
  id: string,
  over: Partial<DealCandidate> & { price?: number; verdictBp?: number } = {},
): DealCandidate {
  const price = over.price ?? 1_000_000;
  const genuine = over.verdictBp ?? 0;
  return {
    id,
    title: over.title ?? "Acme Nova 7 5G",
    productId: `p-${id}`,
    variantId: `v-${id}`,
    sourceId: "s",
    stockStatus: over.stockStatus ?? "IN_STOCK",
    launchDate: over.launchDate ?? null,
    pricing: {
      sellingPricePaise: price,
      effectivePricePaise: price,
      mrpPaise: null,
      claimedDiscountBp: 0,
      claimedSavingsPaise: 0,
      genuineDiscountBp: genuine,
      verdict: genuine > 0 ? "GENUINE" : "INSUFFICIENT_HISTORY",
      history: { points: 0, spanDays: 0, minPaise: null, medianPaise: null, maxPaise: null },
      reasons: [],
      ...over.pricing,
    },
  };
}

describe("ranking engine", () => {
  it("scores relevance by query-token coverage", () => {
    expect(relevanceBp("acme nova 5g", "Acme Nova 7 5G (8GB RAM)")).toBe(10_000);
    expect(relevanceBp("acme nova pro", "Acme Nova 7")).toBe(6_666);
  });

  it("ranks deterministically per mode, in-stock first, stable ties", () => {
    const deals = [
      deal("a", { price: 2_000_000 }),
      deal("b", { price: 1_000_000 }),
      deal("c", { price: 1_500_000, verdictBp: 2_000 }),
      deal("d", { price: 500_000, stockStatus: "OUT_OF_STOCK" }),
      deal("e", { price: 1_200_000, launchDate: new Date("2026-10-01") }),
    ];
    const ids = (mode: Parameters<typeof rankDeals>[2]) =>
      rankDeals("acme nova", deals, mode).map((r) => r.deal.id);
    expect(ids("cheapest")).toEqual(["b", "e", "c", "a", "d"]);
    expect(ids("highest_discount")[0]).toBe("c");
    expect(ids("newest")[0]).toBe("e");
    expect(ids("best_value")).toEqual(ids("best_value")); // stable
    expect(ids("best_value").at(-1)).toBe("d"); // out of stock last even though cheapest
    const ranked = rankDeals("acme nova", deals, "best_value");
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(ranked[0]?.breakdown).toMatchObject({ relevance: 10_000 });
  });

  it("does not let an unverifiable MRP discount boost a deal", () => {
    const fake = deal("fake", { price: 1_000_000, pricing: { claimedDiscountBp: 8_000 } as never });
    const plain = deal("plain", { price: 1_000_000 });
    const r = rankDeals("acme", [fake, plain], "best_value");
    expect(r[0]?.score).toBe(r[1]?.score);
  });
});
