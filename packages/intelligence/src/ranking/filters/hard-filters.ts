/**
 * Hard filters, applied before any scoring and never relaxed. A required
 * specification that a listing doesn't state can't be verified, so the listing
 * is excluded (and the reason reported), not assumed to match.
 */
import type { ExclusionReason, HardFilters, PriceBasis, RankCandidate } from "../types.js";

const brandKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Numeric equality for numbers; case/whitespace-insensitive text equality otherwise. */
export function specMatches(actual: unknown, wanted: string | number): boolean {
  // Only scalar values can match (objects/arrays never do).
  if (typeof actual !== "string" && typeof actual !== "number" && typeof actual !== "boolean")
    return false;
  if (typeof wanted === "number") {
    if (typeof actual === "number") return actual === wanted;
    // "8 GB" → 8; text without a number never equals a number.
    const m = /^\s*(\d+(?:\.\d+)?)\s*[a-z]*\s*$/i.exec(String(actual));
    return m !== null && Number(m[1]) === wanted;
  }
  const norm = (v: unknown) => String(v).toLowerCase().replace(/\s+/g, "");
  return norm(actual) === norm(wanted);
}

export function specOf(c: RankCandidate, key: string): unknown {
  return c.variantAttributes[key] ?? c.specifications[key];
}

export function rankingPrice(c: RankCandidate, basis: PriceBasis): number {
  return basis === "best_verified"
    ? c.pricing.prices.bestVerifiedPayablePaise
    : c.pricing.prices.deliveredPaise;
}

export function hardFilter(
  c: RankCandidate,
  f: HardFilters,
  basis: PriceBasis,
  now: Date,
  maxPriceAgeHours: number,
): { reason: ExclusionReason; detail?: string } | null {
  if (c.stockStatus === "OUT_OF_STOCK") return { reason: "UNAVAILABLE" };
  if (c.pricing.priceType === "INDICATIVE") return { reason: "INDICATIVE_PRICE" };
  const ageMs = now.getTime() - new Date(c.pricing.observedAt).getTime();
  if (ageMs > maxPriceAgeHours * 3_600_000)
    return { reason: "STALE_PRICE", detail: c.pricing.observedAt };
  if (f.excludedOfferIds?.includes(c.offerId)) return { reason: "OFFER_EXCLUDED" };
  if (f.excludedProductIds?.includes(c.productId)) return { reason: "PRODUCT_EXCLUDED" };
  if (f.variantIds?.length && !f.variantIds.includes(c.variantId))
    return { reason: "VARIANT_NOT_REQUESTED" };
  if (f.sourceSlugs?.length && !f.sourceSlugs.includes(c.sourceSlug))
    return { reason: "SOURCE_NOT_REQUESTED" };
  if (f.excludedSourceSlugs?.includes(c.sourceSlug)) return { reason: "SOURCE_EXCLUDED" };
  if (f.categorySlugs?.length && !c.categoryPath.some((s) => f.categorySlugs!.includes(s))) {
    return { reason: "CATEGORY" };
  }
  const price = rankingPrice(c, basis);
  if (f.minPricePaise !== undefined && price < f.minPricePaise)
    return { reason: "BELOW_MIN_PRICE" };
  if (f.maxPricePaise !== undefined && price > f.maxPricePaise)
    return { reason: "ABOVE_MAX_PRICE" };
  const bk = brandKey(c.brand);
  if (f.brands?.length && !f.brands.some((b) => brandKey(b) === bk))
    return { reason: "BRAND_NOT_REQUESTED" };
  if (f.excludedBrands?.some((b) => brandKey(b) === bk)) return { reason: "BRAND_EXCLUDED" };
  for (const [key, wanted] of Object.entries(f.requiredSpecs ?? {})) {
    const actual = specOf(c, key);
    if (actual === undefined || actual === null) return { reason: "SPEC_NOT_STATED", detail: key };
    if (!specMatches(actual, wanted)) return { reason: "SPEC_MISMATCH", detail: key };
  }
  for (const [key, unwanted] of Object.entries(f.excludedSpecs ?? {})) {
    if (specMatches(specOf(c, key), unwanted)) return { reason: "SPEC_EXCLUDED", detail: key };
  }
  return null;
}
