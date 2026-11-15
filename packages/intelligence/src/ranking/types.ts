import { z } from "zod";
import type { PricingResult, StockStatus } from "../pricing/engine.js";

export const RANKING_MODES = [
  "highest_discount",
  "lowest_price",
  "best_value",
  "recently_launched",
  "price_drop",
  "trending_deals",
  "relevance",
] as const;
export type RankingMode = (typeof RANKING_MODES)[number];

/** Earlier names, still accepted. */
export const MODE_ALIASES = { cheapest: "lowest_price", newest: "recently_launched" } as const;
export const SORT_MODES = [
  ...RANKING_MODES,
  ...(Object.keys(MODE_ALIASES) as (keyof typeof MODE_ALIASES)[]),
] as const;
export type SortMode = (typeof SORT_MODES)[number];

export function resolveMode(mode: SortMode): RankingMode {
  return (MODE_ALIASES as Record<string, RankingMode>)[mode] ?? (mode as RankingMode);
}

/**
 * What ranking may look at. There is deliberately no affiliate, commission or
 * revenue field: monetization can never influence rank.
 */
export interface RankCandidate {
  offerId: string;
  productId: string;
  variantId: string;
  sourceSlug: string;
  sourceName: string;
  title: string;
  productName: string;
  brand: string;
  /** Category slugs from the product's category up to the root. */
  categoryPath: string[];
  stockStatus: StockStatus;
  launchDate: Date | null;
  variantAttributes: Record<string, unknown>;
  specifications: Record<string, unknown>;
  pricing: PricingResult;
}

const specValue = z.union([z.string().max(100), z.number()]);

export const hardFiltersSchema = z
  .object({
    categorySlugs: z.array(z.string().max(100)).max(20).optional(),
    minPricePaise: z.number().int().min(0).optional(),
    maxPricePaise: z.number().int().min(0).optional(),
    brands: z.array(z.string().max(100)).max(30).optional(),
    excludedBrands: z.array(z.string().max(100)).max(30).optional(),
    requiredSpecs: z.record(specValue).optional(),
    excludedSpecs: z.record(specValue).optional(),
    variantIds: z.array(z.string().uuid()).max(400).optional(),
    excludedProductIds: z.array(z.string().uuid()).max(400).optional(),
    excludedOfferIds: z.array(z.string().uuid()).max(400).optional(),
    sourceSlugs: z.array(z.string().max(50)).max(20).optional(),
    excludedSourceSlugs: z.array(z.string().max(50)).max(20).optional(),
  })
  .strict();
export type HardFilters = z.infer<typeof hardFiltersSchema>;

/** best_value weights (relative; renormalized over the components that have data). */
export interface BestValueWeights {
  price: number;
  specMatch: number;
  discount: number;
  history: number;
  relevance: number;
  quality: number;
}

export const DEFAULT_BEST_VALUE_WEIGHTS: BestValueWeights = {
  price: 35,
  specMatch: 20,
  discount: 15,
  history: 15,
  relevance: 15,
  // No reliable quality data exists (no ratings are collected): weight unused.
  quality: 10,
};

export const weightsSchema = z
  .object({
    price: z.number().int().min(0).max(100),
    specMatch: z.number().int().min(0).max(100),
    discount: z.number().int().min(0).max(100),
    history: z.number().int().min(0).max(100),
    relevance: z.number().int().min(0).max(100),
    quality: z.number().int().min(0).max(100),
  })
  .partial()
  .strict();

export type PriceBasis = "delivered" | "best_verified";

export interface RankingOptions {
  mode: SortMode;
  query?: string;
  filters?: HardFilters;
  /** Soft preferences (scored, not filtered). */
  preferredSpecs?: Record<string, string | number>;
  /** Price compared: delivered (default) or best verified payable (verified, eligible benefits only). */
  priceBasis?: PriceBasis;
  weights?: Partial<BestValueWeights>;
  /** Offers observed longer ago than this are not ranked as live (default 24h). */
  maxPriceAgeHours?: number;
  /** "Recently launched" window (default 365 days). */
  recentlyLaunchedDays?: number;
  /** Optional quality signals per product id, only from a trustworthy source (0–10000). None exist yet. */
  qualityBp?: Record<string, number>;
  now?: Date;
}

/** Component scores 0–10000; null = no data (excluded from weighting, never guessed). */
export interface ScoreComponents {
  price: number;
  discount: number | null;
  history: number | null;
  specMatch: number | null;
  relevance: number | null;
  quality: number | null;
  recency: number | null;
  priceDrop: number | null;
}

export type ExclusionReason =
  | "UNAVAILABLE"
  | "STALE_PRICE"
  | "INDICATIVE_PRICE"
  | "CATEGORY"
  | "BELOW_MIN_PRICE"
  | "ABOVE_MAX_PRICE"
  | "BRAND_NOT_REQUESTED"
  | "BRAND_EXCLUDED"
  | "SPEC_NOT_STATED"
  | "SPEC_MISMATCH"
  | "SPEC_EXCLUDED"
  | "VARIANT_NOT_REQUESTED"
  | "PRODUCT_EXCLUDED"
  | "OFFER_EXCLUDED"
  | "SOURCE_NOT_REQUESTED"
  | "SOURCE_EXCLUDED";

export interface RankedDeal {
  rank: number;
  offerId: string;
  productId: string;
  variantId: string;
  marketplace: { slug: string; name: string };
  title: string;
  sellingPricePaise: number;
  deliveredPricePaise: number;
  /** The price this ranking compared (delivered or best verified payable). */
  rankingPricePaise: number;
  directDiscount: PricingResult["directDiscount"];
  conditionalBenefits: PricingResult["benefits"];
  historicalContext: {
    lowestClaim: PricingResult["history"]["lowestClaim"];
    trend: PricingResult["history"]["trend"];
    lowest90DaysPaise: number | null;
    coverage90DaysBp: number;
    changeVs30DayAverageBp: number | null;
    recentDrop: PricingResult["history"]["recentDrop"];
    genuineDiscountVerdict: PricingResult["assessment"]["verdict"];
  };
  stockStatus: StockStatus;
  /** False for PREORDER/UNKNOWN stock: ranked after confirmed-available offers. */
  availabilityConfirmed: boolean;
  score: number;
  components: ScoreComponents;
  explanation: { summary: string; factors: string[]; versusNext: string | null };
  priceObservedAt: string;
}

export interface RankingResult {
  requestedMode: SortMode;
  appliedMode: RankingMode;
  priceBasis: PriceBasis;
  /** Weights used for best_value (after renormalization notes in docs). */
  weights: BestValueWeights;
  ranked: RankedDeal[];
  excluded: { offerId: string; reason: ExclusionReason; detail?: string }[];
  warnings: string[];
  computedAt: string;
}
