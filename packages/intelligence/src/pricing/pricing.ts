/**
 * Deterministic pricing engine. Integer paise and basis points only.
 *
 *  - Direct discount: MRP vs selling price (as the marketplace states it).
 *  - Genuine discount: the current price vs this offer's own recent price
 *    history. An MRP discount alone is NOT proof of a deal (MRPs are often
 *    inflated), so a deal is only called GENUINE when history supports it.
 *  - Conditional benefits (bank offers, coupons…) are never part of these
 *    numbers; they live in offerConditions.
 */
import { type Paise, discountBasisPoints, paise, savingsPaise } from "@dealmind/shared";

export interface PricePoint {
  sellingPricePaise: number;
  observedAt: Date;
}

export interface PricingRules {
  /** History window considered (days). */
  windowDays: number;
  /** Minimum snapshots and span needed to judge a discount. */
  minPoints: number;
  minSpanDays: number;
  /** Current price must be this far below the window median to count as genuine (bp). */
  genuineBelowMedianBp: number;
}

export const DEFAULT_PRICING_RULES: PricingRules = {
  windowDays: 90,
  minPoints: 5,
  minSpanDays: 14,
  genuineBelowMedianBp: 500,
};

export type DiscountVerdict = "GENUINE" | "NOT_GENUINE" | "INSUFFICIENT_HISTORY";

export interface PriceAssessment {
  sellingPricePaise: number;
  effectivePricePaise: number;
  mrpPaise: number | null;
  /** Discount the listing claims vs MRP (bp). */
  claimedDiscountBp: number;
  claimedSavingsPaise: number;
  /** Discount vs this offer's typical (median) price in the window (bp; 0 when not lower). */
  genuineDiscountBp: number;
  verdict: DiscountVerdict;
  history: {
    points: number;
    spanDays: number;
    minPaise: number | null;
    medianPaise: number | null;
    maxPaise: number | null;
  };
  /** Machine-readable reasons, e.g. "LOWEST_IN_WINDOW", "AT_OR_ABOVE_TYPICAL_PRICE". */
  reasons: string[];
}

/** Selling price + shipping (paise). Conditional benefits are deliberately excluded. */
export function effectivePricePaise(
  sellingPricePaise: number,
  shippingPaise?: number | null,
): Paise {
  return paise(sellingPricePaise + (shippingPaise ?? 0));
}

/** Lower median of integers (no floating point). */
export function medianPaise(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export function assessPrice(
  offer: { sellingPricePaise: number; mrpPaise?: number | null; shippingPaise?: number | null },
  history: PricePoint[],
  now: Date = new Date(),
  rules: PricingRules = DEFAULT_PRICING_RULES,
): PriceAssessment {
  const selling = paise(offer.sellingPricePaise);
  const mrp = offer.mrpPaise == null ? null : paise(offer.mrpPaise);
  const from = now.getTime() - rules.windowDays * 86_400_000;
  const window = history.filter(
    (p) => p.observedAt.getTime() >= from && p.observedAt.getTime() <= now.getTime(),
  );
  const prices = window.map((p) => p.sellingPricePaise);
  const times = window.map((p) => p.observedAt.getTime());
  const spanDays = times.length
    ? Math.floor((Math.max(...times) - Math.min(...times)) / 86_400_000)
    : 0;
  const med = medianPaise(prices);
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const claimedDiscountBp = discountBasisPoints(selling, mrp);
  const reasons: string[] = [];
  let verdict: DiscountVerdict;
  let genuineDiscountBp = 0;

  if (
    prices.length < rules.minPoints ||
    spanDays < rules.minSpanDays ||
    med === null ||
    min === null
  ) {
    verdict = "INSUFFICIENT_HISTORY";
    reasons.push("NOT_ENOUGH_PRICE_HISTORY");
  } else {
    genuineDiscountBp = selling < med ? Math.floor(((med - selling) * 10_000) / med) : 0;
    if (selling <= min) reasons.push("LOWEST_IN_WINDOW");
    if (genuineDiscountBp >= rules.genuineBelowMedianBp || selling < min) {
      verdict = "GENUINE";
      reasons.push("BELOW_TYPICAL_PRICE");
    } else {
      verdict = "NOT_GENUINE";
      reasons.push(
        selling >= med ? "AT_OR_ABOVE_TYPICAL_PRICE" : "ONLY_SLIGHTLY_BELOW_TYPICAL_PRICE",
      );
      if (claimedDiscountBp >= 1_000) reasons.push("MRP_DISCOUNT_NOT_REFLECTED_IN_HISTORY");
    }
  }
  if (mrp === null) reasons.push("NO_MRP");
  else if (mrp <= selling) reasons.push("NO_DISCOUNT_FROM_MRP");

  return {
    sellingPricePaise: selling,
    effectivePricePaise: effectivePricePaise(selling, offer.shippingPaise),
    mrpPaise: mrp,
    claimedDiscountBp,
    claimedSavingsPaise: savingsPaise(selling, mrp),
    genuineDiscountBp,
    verdict,
    history: { points: prices.length, spanDays, minPaise: min, medianPaise: med, maxPaise: max },
    reasons,
  };
}
