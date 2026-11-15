import { describe, expect, it } from "vitest";
import { assessPrice, effectivePricePaise, medianPaise, type PricePoint } from "./pricing.js";

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
