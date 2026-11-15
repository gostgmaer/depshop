/**
 * Ranking strategies: score + deterministic ordering per mode. Ties always
 * break on ranking price, then offer id, so equal inputs give equal output.
 */
import type { BestValueWeights, RankCandidate, RankingMode, ScoreComponents } from "../types.js";

export interface Scored {
  c: RankCandidate;
  price: number;
  /** 0 = availability confirmed (IN_STOCK/LIMITED), 1 = PREORDER/UNKNOWN. */
  avail: number;
  components: ScoreComponents;
  /** Component keys that took part in the score and their effective weights. */
  used: Partial<Record<keyof ScoreComponents, number>>;
  score: number;
}

/** Weighted mean over the components that have data; integer 0–10000. */
export function weighted(
  components: ScoreComponents,
  weights: Partial<Record<keyof ScoreComponents, number>>,
): { score: number; used: Partial<Record<keyof ScoreComponents, number>> } {
  let sum = 0;
  let total = 0;
  const used: Partial<Record<keyof ScoreComponents, number>> = {};
  for (const [k, w] of Object.entries(weights) as [keyof ScoreComponents, number][]) {
    const v = components[k];
    if (!w || v === null) continue;
    sum += v * w;
    total += w;
    used[k] = w;
  }
  return { score: total ? Math.floor(sum / total) : 0, used };
}

export function modeWeights(
  mode: RankingMode,
  bv: BestValueWeights,
): Partial<Record<keyof ScoreComponents, number>> {
  switch (mode) {
    case "best_value":
      return {
        price: bv.price,
        specMatch: bv.specMatch,
        discount: bv.discount,
        history: bv.history,
        relevance: bv.relevance,
        quality: bv.quality,
      };
    case "lowest_price":
      return { price: 1 };
    case "highest_discount":
      return { discount: 1 };
    case "recently_launched":
      return { recency: 60, price: 40 };
    case "price_drop":
      return { priceDrop: 1 };
    case "relevance":
      return { relevance: 1 };
    case "trending_deals":
      // Never reached: trending falls back to best_value (no trustworthy demand data).
      return { price: 1 };
  }
}

const tie = (a: Scored, b: Scored) => a.price - b.price || a.c.offerId.localeCompare(b.c.offerId);
const desc = (x: number | null) => (x === null ? -1 : x);

export function comparator(mode: RankingMode): (a: Scored, b: Scored) => number {
  switch (mode) {
    case "lowest_price":
      return (a, b) =>
        a.price - b.price ||
        desc(b.c.pricing.directDiscount.percentBp) - desc(a.c.pricing.directDiscount.percentBp) ||
        a.c.offerId.localeCompare(b.c.offerId);
    case "highest_discount":
      // Verifiable discounts first (by %, then amount); offers without a valid MRP after.
      return (a, b) =>
        desc(b.components.discount) - desc(a.components.discount) ||
        desc(b.c.pricing.directDiscount.percentBp) - desc(a.c.pricing.directDiscount.percentBp) ||
        desc(b.c.pricing.directDiscount.amountPaise) -
          desc(a.c.pricing.directDiscount.amountPaise) ||
        tie(a, b);
    case "recently_launched":
      // Known launch dates first.
      return (a, b) =>
        Number(b.components.recency !== null) - Number(a.components.recency !== null) ||
        b.score - a.score ||
        tie(a, b);
    case "price_drop":
      return (a, b) =>
        desc(b.components.priceDrop) - desc(a.components.priceDrop) ||
        desc(b.c.pricing.history.recentDrop?.dropPaise ?? null) -
          desc(a.c.pricing.history.recentDrop?.dropPaise ?? null) ||
        tie(a, b);
    default:
      return (a, b) => b.score - a.score || tie(a, b);
  }
}
