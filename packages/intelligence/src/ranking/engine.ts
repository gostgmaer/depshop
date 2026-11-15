/**
 * Deal ranking: hard filters → score components → mode strategy → explanation.
 * Deterministic: same candidates + options + clock → same order and scores.
 * Inputs carry no affiliate/commission data, so monetization can't affect rank.
 */
import { formatPaise } from "@dealmind/shared";
import { dealFactors, summary, versusNext } from "./explainers/explain.js";
import { hardFilter, rankingPrice } from "./filters/hard-filters.js";
import {
  discountScore,
  historyScore,
  priceCompetitiveness,
  priceDropScore,
  recencyScore,
  relevanceScore,
  specMatchScore,
} from "./scorers/scorers.js";
import { type Scored, comparator, modeWeights, weighted } from "./strategies/strategies.js";
import {
  type BestValueWeights,
  DEFAULT_BEST_VALUE_WEIGHTS,
  type RankCandidate,
  type RankedDeal,
  type RankingMode,
  type RankingOptions,
  type RankingResult,
  resolveMode,
} from "./types.js";

export function rankOffers(candidates: RankCandidate[], options: RankingOptions): RankingResult {
  const now = options.now ?? new Date();
  const basis = options.priceBasis ?? "delivered";
  const weights: BestValueWeights = { ...DEFAULT_BEST_VALUE_WEIGHTS, ...options.weights };
  const warnings: string[] = [];
  let mode: RankingMode = resolveMode(options.mode);
  if (mode === "trending_deals") {
    // No trustworthy demand/popularity data is collected, and none is invented.
    warnings.push("TRENDING_DATA_UNAVAILABLE: ranked as best_value instead");
    mode = "best_value";
  }

  const excluded: RankingResult["excluded"] = [];
  const kept: RankCandidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.offerId)) continue;
    seen.add(c.offerId);
    const out = hardFilter(c, options.filters ?? {}, basis, now, options.maxPriceAgeHours ?? 24);
    if (out) excluded.push({ offerId: c.offerId, ...out });
    else kept.push(c);
  }

  const prices = kept.map((c) => rankingPrice(c, basis));
  const lo = prices.length ? Math.min(...prices) : 0;
  const w = modeWeights(mode, weights);
  const scored: Scored[] = kept.map((c) => {
    const price = rankingPrice(c, basis);
    const components = {
      price: priceCompetitiveness(price, lo),
      discount: discountScore(c.pricing),
      history: historyScore(c.pricing),
      specMatch: specMatchScore(c, options.preferredSpecs),
      relevance: relevanceScore(options.query, c.title),
      quality: options.qualityBp?.[c.productId] ?? null,
      recency: recencyScore(c.launchDate, now, options.recentlyLaunchedDays ?? 365),
      priceDrop: priceDropScore(c.pricing),
    };
    const { score, used } = weighted(components, w);
    const avail = c.stockStatus === "IN_STOCK" || c.stockStatus === "LIMITED" ? 0 : 1;
    return { c, price, avail, components, used, score };
  });

  const cmp = comparator(mode);
  scored.sort((a, b) => a.avail - b.avail || cmp(a, b));

  if (mode === "best_value" && !options.qualityBp) {
    warnings.push("QUALITY_DATA_UNAVAILABLE: quality weight not used");
  }
  if (mode === "recently_launched" && scored.some((s) => s.components.recency === null)) {
    warnings.push("LAUNCH_DATE_UNKNOWN: offers without a launch date ranked after dated ones");
  }
  if (mode === "highest_discount" && scored.some((s) => s.components.discount === null)) {
    warnings.push("NO_VERIFIABLE_MRP: offers without a valid MRP ranked after discounted ones");
  }

  const ranked: RankedDeal[] = scored.map((s, i) => {
    const p = s.c.pricing;
    const w90 = p.history.windows.find((x) => x.days === 90);
    return {
      rank: i + 1,
      offerId: s.c.offerId,
      productId: s.c.productId,
      variantId: s.c.variantId,
      marketplace: { slug: s.c.sourceSlug, name: s.c.sourceName },
      title: s.c.title,
      sellingPricePaise: p.prices.basePaise,
      deliveredPricePaise: p.prices.deliveredPaise,
      rankingPricePaise: s.price,
      directDiscount: p.directDiscount,
      conditionalBenefits: p.benefits,
      historicalContext: {
        lowestClaim: p.history.lowestClaim,
        trend: p.history.trend,
        lowest90DaysPaise: w90?.lowestPaise ?? null,
        coverage90DaysBp: w90?.coverageBp ?? 0,
        changeVs30DayAverageBp: p.history.changeVs30DayAverageBp,
        recentDrop: p.history.recentDrop,
        genuineDiscountVerdict: p.assessment.verdict,
      },
      stockStatus: s.c.stockStatus,
      availabilityConfirmed: s.avail === 0,
      score: s.score,
      components: s.components,
      explanation: {
        summary: summary(s, mode, basis),
        factors: dealFactors(s, basis),
        versusNext: versusNext(s, scored[i + 1], i + 2, mode, basis),
      },
      priceObservedAt: p.observedAt,
    };
  });

  return {
    requestedMode: options.mode,
    appliedMode: mode,
    priceBasis: basis,
    weights,
    ranked,
    excluded,
    warnings,
    computedAt: now.toISOString(),
  };
}

export interface OfferComparison {
  offers: {
    offerId: string;
    marketplace: { slug: string; name: string };
    variantId: string;
    stockStatus: RankCandidate["stockStatus"];
    sellingPricePaise: number;
    deliveredPricePaise: number;
    bestVerifiedPayablePaise: number;
    directDiscount: RankCandidate["pricing"]["directDiscount"];
    cashbackPaise: number | null;
    exchangeMaxBenefitPaise: number | null;
    lowestClaim: RankCandidate["pricing"]["history"]["lowestClaim"];
    /** Delivered price minus the cheapest delivered price in this comparison. */
    deliveredVsCheapestPaise: number;
    priceObservedAt: string;
  }[];
  cheapestDelivered: string | null;
  cheapestVerifiedPayable: string | null;
  highestDirectDiscount: string | null;
  sameVariant: boolean;
  notes: string[];
}

/** Side-by-side comparison (e.g. the same variant across marketplaces). */
export function compareOffers(candidates: RankCandidate[]): OfferComparison {
  const notes: string[] = [];
  const list = [...new Map(candidates.map((c) => [c.offerId, c])).values()].sort((a, b) =>
    a.offerId.localeCompare(b.offerId),
  );
  const available = list.filter((c) => c.stockStatus !== "OUT_OF_STOCK");
  const minBy = (xs: RankCandidate[], f: (c: RankCandidate) => number) =>
    xs.length ? xs.reduce((a, b) => (f(b) < f(a) ? b : a)).offerId : null;
  const cheapest = available.length
    ? Math.min(...available.map((c) => c.pricing.prices.deliveredPaise))
    : 0;
  const withDiscount = available.filter((c) => c.pricing.directDiscount.status === "OK");
  const sameVariant = new Set(list.map((c) => c.variantId)).size <= 1;
  if (!sameVariant)
    notes.push("These offers are for different variants; prices are not like-for-like.");
  if (list.length > available.length)
    notes.push("Out-of-stock offers are shown but not chosen as best.");
  const cd = minBy(available, (c) => c.pricing.prices.deliveredPaise);
  if (cd) {
    const c = list.find((x) => x.offerId === cd)!;
    notes.push(
      `Cheapest delivered: ${formatPaise(c.pricing.prices.deliveredPaise)} on ${c.sourceName}.`,
    );
  }
  return {
    offers: list.map((c) => ({
      offerId: c.offerId,
      marketplace: { slug: c.sourceSlug, name: c.sourceName },
      variantId: c.variantId,
      stockStatus: c.stockStatus,
      sellingPricePaise: c.pricing.prices.basePaise,
      deliveredPricePaise: c.pricing.prices.deliveredPaise,
      bestVerifiedPayablePaise: c.pricing.prices.bestVerifiedPayablePaise,
      directDiscount: c.pricing.directDiscount,
      cashbackPaise: c.pricing.prices.cashbackPaise,
      exchangeMaxBenefitPaise: c.pricing.prices.exchangeMaxBenefitPaise,
      lowestClaim: c.pricing.history.lowestClaim,
      deliveredVsCheapestPaise: c.pricing.prices.deliveredPaise - cheapest,
      priceObservedAt: c.pricing.observedAt,
    })),
    cheapestDelivered: cd,
    cheapestVerifiedPayable: minBy(available, (c) => c.pricing.prices.bestVerifiedPayablePaise),
    highestDirectDiscount: withDiscount.length
      ? withDiscount.reduce((a, b) =>
          (b.pricing.directDiscount.percentBp ?? 0) > (a.pricing.directDiscount.percentBp ?? 0)
            ? b
            : a,
        ).offerId
      : null,
    sameVariant,
    notes,
  };
}
