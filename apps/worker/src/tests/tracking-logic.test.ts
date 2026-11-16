/** Pure tracking logic: policy, change detection, validation and alert rules. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  intervalMinutes,
  nextCheckAfterFailure,
  nextCheckAfterSuccess,
  priorityOf,
  slotOf,
  tierOf,
} from "../policies/tracking-policy.js";
import {
  type AlertState,
  type CheckContext,
  evaluateAlert,
  priorLow,
} from "../services/alert-rules.js";
import { detectChange, isImplausible, validateObservation } from "../services/price-change.js";

const intervals = { trackingHighMinutes: 30, trackingNormalMinutes: 180, trackingLowMinutes: 720 };
const now = new Date("2026-11-16T10:00:00Z");

describe("tracking policy", () => {
  it("derives the tier from shared demand, not from one user", () => {
    expect(tierOf(0)).toBe("LOW");
    expect(tierOf(1)).toBe("NORMAL");
    expect(tierOf(3)).toBe("HIGH");
    expect(intervalMinutes("HIGH", intervals)).toBe(30);
    expect(intervalMinutes("LOW", intervals)).toBe(720);
    expect(priorityOf("HIGH")).toBeLessThan(priorityOf("LOW"));
  });

  it("jitters the next check within ±10% and backs off on failure, capped", () => {
    const lo = nextCheckAfterSuccess(now, 60, DEFAULT_POLICY, () => 0).getTime() - now.getTime();
    const hi = nextCheckAfterSuccess(now, 60, DEFAULT_POLICY, () => 1).getTime() - now.getTime();
    expect([lo, hi]).toEqual([54 * 60_000, 66 * 60_000]);
    const after = (f: number) =>
      (nextCheckAfterFailure(now, 180, f).getTime() - now.getTime()) / 60_000;
    expect([after(1), after(2), after(3), after(9)]).toEqual([180, 360, 720, 1440]);
    expect(slotOf(now)).toBe("2026-11-16T10:00");
  });
});

describe("price change detection", () => {
  const prev = {
    sellingPricePaise: 2_000_000,
    mrpPaise: 2_500_000,
    shippingPaise: 0,
    stockStatus: "IN_STOCK" as const,
  };

  it("calculates change and percentage in integer paise / basis points", () => {
    const down = detectChange(prev, { ...prev, sellingPricePaise: 1_850_000 });
    expect(down).toMatchObject({ kind: "PRICE_DECREASED", changePaise: -150_000, changeBp: -750 });
    const up = detectChange(prev, { ...prev, sellingPricePaise: 2_000_099 });
    // 99 / 2,000,000 = 0.495 bp → truncated toward zero.
    expect(up).toMatchObject({ kind: "PRICE_INCREASED", changePaise: 99, changeBp: 0 });
    expect(detectChange(prev, prev).kind).toBe("UNCHANGED");
    const stock = detectChange(prev, { ...prev, stockStatus: "OUT_OF_STOCK" });
    expect(stock).toMatchObject({ kind: "OTHER_CHANGED", stockChanged: true, priceChanged: false });
  });

  it("flags implausible jumps for confirmation", () => {
    expect(isImplausible(detectChange(prev, { ...prev, sellingPricePaise: 200_000 }))).toBe(true);
    expect(isImplausible(detectChange(prev, { ...prev, sellingPricePaise: 12_000_000 }))).toBe(
      true,
    );
    expect(isImplausible(detectChange(prev, { ...prev, sellingPricePaise: 1_500_000 }))).toBe(
      false,
    );
  });

  it("rejects observations that can't be prices, instead of treating them as zero", () => {
    const ok = { priceType: "LISTED", currency: "INR", sellingPricePaise: 100 };
    expect(validateObservation(ok)).toBeNull();
    expect(validateObservation({ ...ok, sellingPricePaise: 0 })?.code).toBe("NON_POSITIVE_PRICE");
    expect(validateObservation({ ...ok, priceType: "INDICATIVE" })?.code).toBe("INDICATIVE_PRICE");
    expect(validateObservation({ ...ok, currency: "USD" })?.code).toBe("CURRENCY");
    expect(validateObservation({ ...ok, shippingPaise: -1 })?.code).toBe("BAD_SHIPPING");
  });
});

describe("alert rules", () => {
  const alert = (over: Partial<AlertState>): AlertState => ({
    type: "TARGET_PRICE",
    targetPricePaise: 2_000_000,
    dropPercentBp: null,
    baselinePricePaise: null,
    historicalWindowDays: null,
    lastTriggeredPricePaise: null,
    ...over,
  });
  const ctx = (over: Partial<CheckContext>): CheckContext => ({
    outcome: "PRICE_DECREASED",
    sellingPricePaise: 1_990_000,
    shippingPaise: 0,
    previousPricePaise: 2_100_000,
    stock: "IN_STOCK",
    previousStock: "IN_STOCK",
    marketplace: "Mock Store Alpha",
    productName: "Acme Nova 7 5G",
    priorLowPaise: null,
    ...over,
  });

  it("target reached (≤) vs strictly below (<), on the delivered price", () => {
    expect(evaluateAlert(alert({}), ctx({ sellingPricePaise: 2_000_000 })).outcome).toBe(
      "TRIGGERED",
    );
    expect(
      evaluateAlert(alert({ type: "PRICE_BELOW" }), ctx({ sellingPricePaise: 2_000_000 })).outcome,
    ).toBe("NOT_MET");
    // Shipping counts toward the delivered price.
    expect(
      evaluateAlert(alert({}), ctx({ sellingPricePaise: 1_990_000, shippingPaise: 20_000 }))
        .outcome,
    ).toBe("NOT_MET");
    const d = evaluateAlert(alert({}), ctx({ shippingPaise: null }));
    expect(d.notification?.body).toContain("(shipping not stated)");
  });

  it("notifies again only on a further drop, and re-arms when the condition stops holding", () => {
    const notified = alert({ lastTriggeredPricePaise: 1_990_000 });
    expect(evaluateAlert(notified, ctx({})).outcome).toBe("NOT_MET");
    expect(evaluateAlert(notified, ctx({ sellingPricePaise: 1_980_000 })).outcome).toBe(
      "TRIGGERED",
    );
    expect(evaluateAlert(notified, ctx({ sellingPricePaise: 2_100_000 }))).toMatchObject({
      outcome: "NOT_MET",
      rearm: true,
    });
  });

  it("never triggers a price alert for an unavailable offer", () => {
    expect(evaluateAlert(alert({}), ctx({ stock: "OUT_OF_STOCK" })).outcome).toBe("NOT_MET");
  });

  it("percentage drop measures from a recorded baseline", () => {
    const first = evaluateAlert(
      alert({ type: "PERCENT_DROP", targetPricePaise: null, dropPercentBp: 1000 }),
      ctx({}),
    );
    expect(first).toMatchObject({ outcome: "INSUFFICIENT_DATA", setBaselinePaise: 1_990_000 });
    const a = alert({
      type: "PERCENT_DROP",
      targetPricePaise: null,
      dropPercentBp: 1000,
      baselinePricePaise: 2_200_000,
    });
    // 9.54% is below the 10% threshold; exactly 10.00% (₹22,000 → ₹19,800) triggers.
    expect(evaluateAlert(a, ctx({ sellingPricePaise: 1_990_000 })).outcome).toBe("NOT_MET");
    expect(evaluateAlert(a, ctx({ sellingPricePaise: 1_980_000 })).reason).toBe(
      "Down 10% from ₹22,000.",
    );
  });

  it("historical low needs enough history and never claims all-time", () => {
    const a = alert({ type: "HISTORICAL_LOW", targetPricePaise: null, historicalWindowDays: 90 });
    expect(evaluateAlert(a, ctx({ priorLowPaise: null })).outcome).toBe("INSUFFICIENT_DATA");
    const d = evaluateAlert(a, ctx({ priorLowPaise: 2_000_000 }));
    expect(d.outcome).toBe("TRIGGERED");
    expect(d.notification?.body).toContain("This is not an all-time claim.");
    const day = 86_400_000;
    const obs = (n: number, spanDays: number) =>
      Array.from({ length: n }, (_, i) => ({
        pricePaise: 2_000_000 + i,
        at: new Date(now.getTime() - (i * spanDays * day) / Math.max(1, n - 1)),
      }));
    expect(priorLow(obs(2, 30))).toBeNull();
    expect(priorLow(obs(5, 3))).toBeNull();
    expect(priorLow(obs(5, 30))).toBe(2_000_000);
  });

  it("price change and back in stock follow the check outcome", () => {
    const change = alert({ type: "PRICE_CHANGE", targetPricePaise: null });
    expect(
      evaluateAlert(change, ctx({ outcome: "PRICE_INCREASED", sellingPricePaise: 2_200_000 }))
        .notification?.title,
    ).toBe("Acme Nova 7 5G: price increased on Mock Store Alpha");
    expect(evaluateAlert(change, ctx({ outcome: "OTHER_CHANGED" })).outcome).toBe("NOT_MET");
    const stock = alert({ type: "BACK_IN_STOCK", targetPricePaise: null });
    expect(
      evaluateAlert(stock, ctx({ outcome: "OTHER_CHANGED", previousStock: "OUT_OF_STOCK" }))
        .outcome,
    ).toBe("TRIGGERED");
    expect(
      evaluateAlert(stock, ctx({ outcome: "REAPPEARED", previousStock: "IN_STOCK" })).outcome,
    ).toBe("TRIGGERED");
    expect(
      evaluateAlert(stock, ctx({ outcome: "OTHER_CHANGED", previousStock: "IN_STOCK" })).outcome,
    ).toBe("NOT_MET");
  });
});
