/**
 * Score components, each normalized to 0–10000 integers. A component without
 * data is null (never guessed); best_value renormalizes over the rest.
 */
import { normalizeText } from "@dealmind/catalog";
import type { PricingResult } from "../../pricing/engine.js";
import { specMatches, specOf } from "../filters/hard-filters.js";
import type { RankCandidate } from "../types.js";

const DAY = 86_400_000;

/**
 * Price competitiveness relative to the cheapest offer in the set: 10000 for
 * the cheapest, minus 4 points per bp above it (25% more expensive = 0).
 * Relative, not min-max, so a ₹500 gap isn't scored like a ₹5,000 gap.
 */
export const PRICE_PENALTY_PER_BP = 4;
export function priceCompetitiveness(price: number, lo: number): number {
  if (price <= lo) return 10_000;
  if (lo <= 0) return 0;
  const excessBp = (BigInt(price - lo) * 10_000n) / BigInt(lo);
  const score = 10_000n - excessBp * BigInt(PRICE_PENALTY_PER_BP);
  return score > 0n ? Number(score) : 0;
}

/**
 * Direct discount (MRP − price), only from a valid MRP. 2× the discount %,
 * capped (50% off = full score), then scaled by what the price history says:
 * a discount the history contradicts (NOT_GENUINE) counts half, an
 * unverifiable one (INSUFFICIENT_HISTORY) three quarters.
 */
export function discountScore(p: PricingResult): number | null {
  const d = p.directDiscount;
  if (d.status !== "OK" || d.percentBp === null) return null;
  const raw = Math.min(10_000, d.percentBp * 2);
  const factor = { GENUINE: [1, 1], INSUFFICIENT_HISTORY: [3, 4], NOT_GENUINE: [1, 2] }[
    p.assessment.verdict
  ];
  return Math.floor((raw * factor[0]!) / factor[1]!);
}

/** Position of the current price within the 90-day observed range (lowest = 10000). */
export function historyScore(p: PricingResult): number | null {
  const w = p.history.windows.find((x) => x.days === 90);
  if (!w || w.lowestPaise === null || w.highestPaise === null || w.observations < 3) return null;
  if (w.coverageBp < 5_000) return null;
  const cur = p.prices.basePaise;
  if (w.highestPaise === w.lowestPaise) return 5_000;
  const clamped = Math.min(Math.max(cur, w.lowestPaise), w.highestPaise);
  return Number(
    (BigInt(w.highestPaise - clamped) * 10_000n) / BigInt(w.highestPaise - w.lowestPaise),
  );
}

/** Share of preferred specs the listing states and matches. */
export function specMatchScore(
  c: RankCandidate,
  preferred: Record<string, string | number> | undefined,
): number | null {
  const entries = Object.entries(preferred ?? {});
  if (!entries.length) return null;
  const hits = entries.filter(([k, v]) => specMatches(specOf(c, k), v)).length;
  return Math.floor((hits * 10_000) / entries.length);
}

/** Share of query tokens present in the title. */
export function relevanceScore(query: string | undefined, title: string): number | null {
  const tokens = [
    ...new Set(
      normalizeText(query ?? "")
        .split(" ")
        .filter((t) => t.length > 1),
    ),
  ];
  if (!tokens.length) return null;
  const hay = ` ${normalizeText(title)} `;
  const hits = tokens.filter((t) => hay.includes(` ${t} `)).length;
  return Math.floor((hits * 10_000) / tokens.length);
}

/** Launch recency: 10000 at launch, linearly to 0 at `windowDays`; null when unknown or not yet launched. */
export function recencyScore(launch: Date | null, now: Date, windowDays: number): number | null {
  if (!launch) return null;
  const age = now.getTime() - launch.getTime();
  if (age < 0) return null;
  const days = Math.floor(age / DAY);
  if (days >= windowDays) return 0;
  return Math.floor(((windowDays - days) * 10_000) / windowDays);
}

/** Verified recent drop: 5× the drop % (20% drop = full score); null without a verified drop. */
export function priceDropScore(p: PricingResult): number | null {
  const d = p.history.recentDrop;
  if (!d) return null;
  return Math.min(10_000, d.dropBp * 5);
}
