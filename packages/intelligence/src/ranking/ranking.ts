/**
 * Deterministic deal ranking. Integer scores (0–10000), stable tie-breaking,
 * and an explanation of every component so the response can cite it.
 * Affiliate status/revenue is NOT an input and can never influence rank.
 */
import { normalizeText } from "@dealmind/catalog";
import type { PriceAssessment } from "../pricing/pricing.js";

export const SORT_MODES = [
  "best_value",
  "cheapest",
  "highest_discount",
  "newest",
  "relevance",
] as const;
export type SortMode = (typeof SORT_MODES)[number];

export interface DealCandidate {
  /** Stable id (offer id). */
  id: string;
  title: string;
  productId: string;
  variantId: string;
  sourceId: string;
  stockStatus: "IN_STOCK" | "LIMITED" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  launchDate: Date | null;
  pricing: PriceAssessment;
}

export interface ScoreBreakdown {
  relevance: number;
  price: number;
  genuineDiscount: number;
  availability: number;
}

export interface RankedDeal<T extends DealCandidate = DealCandidate> {
  rank: number;
  score: number;
  breakdown: ScoreBreakdown;
  deal: T;
}

/** Share of query tokens present in the title (bp). */
export function relevanceBp(query: string, title: string): number {
  const tokens = [
    ...new Set(
      normalizeText(query)
        .split(" ")
        .filter((t) => t.length > 1),
    ),
  ];
  if (!tokens.length) return 0;
  const hay = ` ${normalizeText(title)} `;
  const hits = tokens.filter((t) => hay.includes(` ${t} `) || hay.includes(t)).length;
  return Math.floor((hits * 10_000) / tokens.length);
}

const AVAILABILITY: Record<DealCandidate["stockStatus"], number> = {
  IN_STOCK: 10_000,
  LIMITED: 8_000,
  PREORDER: 4_000,
  UNKNOWN: 3_000,
  OUT_OF_STOCK: 0,
};

function inStock(d: DealCandidate): boolean {
  return d.stockStatus === "IN_STOCK" || d.stockStatus === "LIMITED";
}

/** Genuine discount score: 2× the genuine discount, capped; unverifiable/no deal scores 0. */
function genuineScore(p: PriceAssessment): number {
  return p.verdict === "GENUINE" ? Math.min(10_000, p.genuineDiscountBp * 2) : 0;
}

export function rankDeals<T extends DealCandidate>(
  query: string,
  deals: T[],
  mode: SortMode,
): RankedDeal<T>[] {
  if (!deals.length) return [];
  const prices = deals.map((d) => d.pricing.effectivePricePaise);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const scored = deals.map((deal) => {
    const breakdown: ScoreBreakdown = {
      relevance: relevanceBp(query, deal.title),
      // Cheapest in the set = 10000, most expensive = 0.
      price:
        hi === lo
          ? 10_000
          : Math.floor(((hi - deal.pricing.effectivePricePaise) * 10_000) / (hi - lo)),
      genuineDiscount: genuineScore(deal.pricing),
      availability: AVAILABILITY[deal.stockStatus],
    };
    // Weights 40/30/20/10 → integer score 0–10000.
    const bestValue = Math.floor(
      (breakdown.relevance * 4 +
        breakdown.price * 3 +
        breakdown.genuineDiscount * 2 +
        breakdown.availability) /
        10,
    );
    return { deal, breakdown, bestValue };
  });

  const byPrice = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    a.deal.pricing.effectivePricePaise - b.deal.pricing.effectivePricePaise ||
    a.deal.id.localeCompare(b.deal.id);
  const verdictRank = { GENUINE: 0, INSUFFICIENT_HISTORY: 1, NOT_GENUINE: 2 } as const;

  const comparators: Record<
    SortMode,
    (a: (typeof scored)[number], b: (typeof scored)[number]) => number
  > = {
    best_value: (a, b) => b.bestValue - a.bestValue || byPrice(a, b),
    cheapest: (a, b) => byPrice(a, b),
    highest_discount: (a, b) =>
      verdictRank[a.deal.pricing.verdict] - verdictRank[b.deal.pricing.verdict] ||
      b.deal.pricing.genuineDiscountBp - a.deal.pricing.genuineDiscountBp ||
      b.deal.pricing.claimedDiscountBp - a.deal.pricing.claimedDiscountBp ||
      byPrice(a, b),
    newest: (a, b) =>
      (b.deal.launchDate?.getTime() ?? -Infinity) - (a.deal.launchDate?.getTime() ?? -Infinity) ||
      b.bestValue - a.bestValue ||
      byPrice(a, b),
    relevance: (a, b) => b.breakdown.relevance - a.breakdown.relevance || byPrice(a, b),
  };
  return scored
    .sort((a, b) => Number(inStock(b.deal)) - Number(inStock(a.deal)) || comparators[mode](a, b))
    .map((s, i) => ({
      rank: i + 1,
      score: mode === "relevance" ? s.breakdown.relevance : s.bestValue,
      breakdown: s.breakdown,
      deal: s.deal,
    }));
}
