/**
 * Deterministic "best deal" recommendations over a set of offers (one
 * product's marketplaces, or several products being compared). Every pick
 * comes from the ranking engine, so the same hard filters apply (stale,
 * unavailable and indicative offers are never recommended), and every reason
 * is built from the offer's own data. There is no affiliate or commission
 * input anywhere in this module.
 */
import { formatBasisPoints, formatPaise } from "@dealmind/shared";
import { rankOffers } from "./engine.js";
import type { ExclusionReason, RankCandidate, RankedDeal } from "./types.js";

export const RECOMMENDATION_KINDS = [
  "lowest_delivered",
  "highest_direct_discount",
  "best_value",
  "best_history_position",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export interface Recommendation {
  kind: RecommendationKind;
  /** Null when no offer qualifies; `unavailableReason` then says why. */
  offerId: string | null;
  productId: string | null;
  variantId: string | null;
  marketplace: { slug: string; name: string } | null;
  deliveredPricePaise: number | null;
  reasons: string[];
  unavailableReason: string | null;
}

export interface Recommendations {
  items: Recommendation[];
  /** Offers that passed the hard filters. */
  considered: number;
  excluded: { reason: ExclusionReason; count: number }[];
  basis: string;
}

const BASIS =
  "Computed by the deterministic pricing and ranking engines from observed marketplace data. " +
  "Affiliate commission is not an input. Conditional bank, coupon and membership offers are never counted as discounts.";

function pick(kind: RecommendationKind, d: RankedDeal, reasons: string[]): Recommendation {
  return {
    kind,
    offerId: d.offerId,
    productId: d.productId,
    variantId: d.variantId,
    marketplace: d.marketplace,
    deliveredPricePaise: d.deliveredPricePaise,
    reasons,
    unavailableReason: null,
  };
}

function none(kind: RecommendationKind, why: string): Recommendation {
  return {
    kind,
    offerId: null,
    productId: null,
    variantId: null,
    marketplace: null,
    deliveredPricePaise: null,
    reasons: [],
    unavailableReason: why,
  };
}

export function recommend(
  candidates: RankCandidate[],
  options: { now?: Date; maxPriceAgeHours?: number } = {},
): Recommendations {
  const base = { ...options, mode: "lowest_price" as const };
  const cheapest = rankOffers(candidates, base);
  const discount = rankOffers(candidates, { ...base, mode: "highest_discount" });
  const value = rankOffers(candidates, { ...base, mode: "best_value" });

  const counts = new Map<ExclusionReason, number>();
  for (const e of cheapest.excluded) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  const considered = cheapest.ranked.length;
  const noneLeft = "No offer is currently available with a fresh, listed price.";

  const items: Recommendation[] = [];

  // Lowest delivered price.
  const c0 = cheapest.ranked[0];
  if (!c0) items.push(none("lowest_delivered", noneLeft));
  else {
    const next = cheapest.ranked.find((d) => d.deliveredPricePaise > c0.deliveredPricePaise);
    items.push(
      pick("lowest_delivered", c0, [
        `${formatPaise(c0.deliveredPricePaise)} delivered (selling price + shipping + mandatory fees) on ${c0.marketplace.name}.`,
        next
          ? `${formatPaise(next.deliveredPricePaise - c0.deliveredPricePaise)} less than the next cheapest (${next.marketplace.name}).`
          : considered > 1
            ? "Other offers are priced the same."
            : "The only offer currently available.",
      ]),
    );
  }

  // Highest verified direct discount (valid MRP only).
  const d0 = discount.ranked.find(
    (d) => d.directDiscount.status === "OK" && (d.directDiscount.percentBp ?? 0) > 0,
  );
  if (!d0)
    items.push(
      none(
        "highest_direct_discount",
        c0 ? "No current offer has a discount from a valid, stated MRP." : noneLeft,
      ),
    );
  else {
    const dd = d0.directDiscount;
    const verdict = d0.historicalContext.genuineDiscountVerdict;
    items.push(
      pick("highest_direct_discount", d0, [
        `${dd.percentText ?? formatBasisPoints(dd.percentBp ?? 0)} off its stated MRP of ${formatPaise(dd.mrpPaise ?? 0)} on ${d0.marketplace.name}.`,
        verdict === "GENUINE"
          ? "Price history confirms the price is below its usual level."
          : verdict === "NOT_GENUINE"
            ? "Price history shows this is its usual price, so the discount is MRP-only."
            : "Not enough price history yet to confirm the discount is below the usual price.",
      ]),
    );
  }

  // Best value (engine's weighted score).
  const v0 = value.ranked[0];
  if (!v0) items.push(none("best_value", noneLeft));
  else
    items.push(
      pick("best_value", v0, [
        `Highest best-value score (${v0.score}/10000) among ${considered} offer${considered === 1 ? "" : "s"}.`,
        ...v0.explanation.factors.slice(0, 3),
      ]),
    );

  // Best position within its own 90-day observed range.
  const h0 = [...value.ranked]
    .filter((d) => d.components.history !== null)
    .sort(
      (a, b) =>
        (b.components.history ?? 0) - (a.components.history ?? 0) ||
        a.deliveredPricePaise - b.deliveredPricePaise ||
        a.offerId.localeCompare(b.offerId),
    )[0];
  if (!h0)
    items.push(
      none(
        "best_history_position",
        c0
          ? "Not enough price history (at least 3 observations covering half of the last 90 days) to compare positions."
          : noneLeft,
      ),
    );
  else {
    const h = h0.historicalContext;
    const reasons = [
      h.lowestClaim.text ??
        `At ${Math.floor(((h0.components.history ?? 0) * 100) / 10_000)}% of the way from its 90-day high to its 90-day low.`,
    ];
    if (h.changeVs30DayAverageBp !== null && h.changeVs30DayAverageBp !== 0)
      reasons.push(
        `${formatBasisPoints(Math.abs(h.changeVs30DayAverageBp))} ${h.changeVs30DayAverageBp < 0 ? "below" : "above"} its 30-day average.`,
      );
    reasons.push(`${Math.floor(h.coverage90DaysBp / 100)}% of the last 90 days observed.`);
    items.push(pick("best_history_position", h0, reasons));
  }

  return {
    items,
    considered,
    excluded: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => a.reason.localeCompare(b.reason)),
    basis: BASIS,
  };
}
