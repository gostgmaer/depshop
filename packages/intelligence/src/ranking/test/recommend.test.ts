import { describe, expect, it } from "vitest";
import { NOW, candidate, daily, daysAgo, rs } from "../../pricing/test/fixtures.js";
import { recommend } from "../recommend.js";

const byKind = (r: ReturnType<typeof recommend>) =>
  Object.fromEntries(r.items.map((i) => [i.kind, i]));

describe("best-deal recommendations", () => {
  it("picks each label from the engine and explains it with the offer's own data", () => {
    // Cheapest, but no MRP.
    const cheap = candidate({ source: "Store A", selling: rs(23_999), mrp: null });
    // 25% off a valid MRP, with 60 days of history at a higher usual price.
    const discounted = candidate({
      source: "Store B",
      selling: rs(24_499),
      mrp: rs(32_666),
      snapshots: [...daily(rs(27_999), 60, 2), ...daily(rs(24_499), 1, 1)],
    });
    const plain = candidate({ source: "Store C", selling: rs(24_999), mrp: rs(25_999) });
    const r = recommend([cheap, discounted, plain], { now: NOW });
    const k = byKind(r);

    expect(k.lowest_delivered).toMatchObject({
      offerId: cheap.offerId,
      deliveredPricePaise: rs(23_999),
    });
    expect(k.lowest_delivered!.reasons.join(" ")).toContain(
      "₹500 less than the next cheapest (Store B)",
    );

    expect(k.highest_direct_discount).toMatchObject({ offerId: discounted.offerId });
    expect(k.highest_direct_discount!.reasons[0]).toMatch(
      /^25% off its stated MRP of ₹32,666 on Store B/,
    );

    // Only the offer with enough history can have a history position.
    expect(k.best_history_position).toMatchObject({ offerId: discounted.offerId });
    expect(k.best_history_position!.reasons.join(" ")).toMatch(/of the last 90 days observed/);

    expect(k.best_value!.offerId).not.toBeNull();
    expect(k.best_value!.reasons[0]).toMatch(
      /^Highest best-value score \(\d+\/10000\) among 3 offers\./,
    );
    expect(r.considered).toBe(3);
    expect(r.basis).toMatch(/Affiliate commission is not an input/);
  });

  it("never recommends stale or out-of-stock offers, and says why when nothing qualifies", () => {
    const stale = candidate({ selling: rs(9_999), observedAt: daysAgo(3) });
    const out = candidate({ selling: rs(10_999), stock: "OUT_OF_STOCK" });
    const ok = candidate({ selling: rs(24_999), mrp: null });
    const r = recommend([stale, out, ok], { now: NOW });
    const k = byKind(r);
    expect(k.lowest_delivered!.offerId).toBe(ok.offerId);
    expect(r.excluded).toEqual([
      { reason: "STALE_PRICE", count: 1 },
      { reason: "UNAVAILABLE", count: 1 },
    ]);
    expect(k.highest_direct_discount).toMatchObject({
      offerId: null,
      unavailableReason: "No current offer has a discount from a valid, stated MRP.",
    });
    expect(k.best_history_position!.offerId).toBeNull();
    expect(k.best_history_position!.unavailableReason).toMatch(/Not enough price history/);

    const nothing = recommend([stale, out], { now: NOW });
    expect(nothing.considered).toBe(0);
    expect(nothing.items.every((i) => i.offerId === null && i.unavailableReason)).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const a = candidate({ selling: rs(20_000) });
    const b = candidate({ selling: rs(20_000) });
    const c = candidate({ selling: rs(21_000) });
    expect(recommend([a, b, c], { now: NOW })).toEqual(recommend([c, b, a], { now: NOW }));
  });
});
