import { describe, expect, it } from "vitest";
import { compareQuery, priceHistoryQuery } from "./contracts.js";
import { describeStats, seriesStats } from "./price-stats.js";

const DAY = 86_400_000;
const t0 = Date.parse("2026-10-01T06:30:00Z");
const pt = (day: number, rupees: number, mrp: number | null = null) => ({
  sellingPricePaise: rupees * 100,
  mrpPaise: mrp === null ? null : mrp * 100,
  observedAt: new Date(t0 + day * DAY).toISOString(),
});

describe("seriesStats", () => {
  it("computes current, previous, low, high, average and changes from observations only", () => {
    const s = seriesStats([pt(0, 30_000), pt(1, 30_000), pt(5, 28_500), pt(6, 27_000)]);
    expect(s.observations).toBe(4);
    expect(s.current?.pricePaise).toBe(2_700_000);
    expect(s.previous?.pricePaise).toBe(2_850_000);
    expect(s.changeFromPreviousPaise).toBe(-150_000);
    expect(s.lowest?.pricePaise).toBe(2_700_000);
    expect(s.highest).toEqual({ pricePaise: 3_000_000, at: pt(0, 0).observedAt });
    // (30000 + 30000 + 28500 + 27000) / 4 = 28875
    expect(s.averagePaise).toBe(2_887_500);
    // (27000 − 28875) / 28875 = −6.49…% → truncated toward zero
    expect(s.currentVsAverageBp).toBe(-649);
    expect(s.periodChangeBp).toBe(-1000);
    expect(s.trend).toBe("FALLING");
    expect(s.changes).toEqual([
      { at: pt(5, 0).observedAt, fromPaise: 3_000_000, toPaise: 2_850_000 },
      { at: pt(6, 0).observedAt, fromPaise: 2_850_000, toPaise: 2_700_000 },
    ]);
    // Day 1 → day 5 is a gap longer than 48 h (no observation in between).
    expect(s.gaps).toBe(1);
  });

  it("phrases statements precisely and never as all-time", () => {
    const s = seriesStats([pt(0, 30_000), pt(5, 28_500), pt(6, 30_000)]);
    const text = describeStats(s, "last 90 days");
    expect(text).toContain("Highest observed price in the last 90 days.");
    expect(text).toContain(
      "Price increased by ₹1,500 since the previous observation (6 Oct 2026).",
    );
    expect(text.join(" ")).toMatch(
      /above its average in the last 90 days \(₹29,500, 3 observations\)/,
    );
    const all = describeStats(seriesStats([pt(0, 30_000), pt(4, 29_000)]), null);
    expect(all[0]).toBe("Lowest observed price since tracking began on 1 Oct 2026.");
    expect(all.join(" ")).not.toMatch(/all-time/i);
  });

  it("does not claim a trend from too little data", () => {
    expect(seriesStats([]).trend).toBe("INSUFFICIENT_DATA");
    expect(describeStats(seriesStats([]), "last 7 days")).toEqual([]);
    const one = seriesStats([pt(0, 10_000)]);
    expect(one.previous).toBeNull();
    expect(describeStats(one, "last 7 days")).toEqual([
      "Only one observation in the last 7 days, so there is nothing to compare yet.",
    ]);
    // Two observations a day apart: a change, but no trend.
    expect(seriesStats([pt(0, 10_000), pt(1, 9_000)]).trend).toBe("INSUFFICIENT_DATA");
  });
});

describe("history and compare queries", () => {
  it("accepts 'all' history and validates compare items", () => {
    expect(priceHistoryQuery.parse({ days: "all" }).days).toBe("all");
    expect(priceHistoryQuery.parse({ days: "7" }).days).toBe(7);
    expect(priceHistoryQuery.safeParse({ days: "400" }).success).toBe(false);
    const P = "10000000-0000-7000-8000-000000000001";
    const V = (n: number) => `20000000-0000-7000-8000-00000000000${n}`;
    expect(compareQuery.parse({ items: `${P}:${V(1)},${P}:${V(2)},${P}:${V(1)}` }).items).toEqual([
      { productId: P, variantId: V(1) },
      { productId: P, variantId: V(2) },
    ]);
    expect(compareQuery.safeParse({ items: "nope" }).success).toBe(false);
    expect(
      compareQuery.safeParse({ items: [1, 2, 3, 4, 5].map((n) => `${P}:${V(n)}`).join(",") })
        .success,
    ).toBe(false);
  });
});
