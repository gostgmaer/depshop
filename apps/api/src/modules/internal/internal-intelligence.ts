/**
 * Deterministic intelligence exposed to the Python agent. Every number the
 * agent receives is computed here from source/database data; the agent can
 * only reference offers by id, never supply prices.
 */
import { normalizeListing, sourceListingSchema } from "@dealmind/catalog";
import { type NormalizedProduct, toSourceListing } from "@dealmind/connectors";
import type { PrismaClient } from "@dealmind/db";
import {
  type CatalogImporter,
  type EligibilityContext,
  PricingService,
  type PricingResult,
  type RankCandidate,
  type RankingOptions,
  type StockStatus,
  rankOffers,
} from "@dealmind/intelligence";

export interface OfferFacts {
  offerId: string;
  productId: string;
  variantId: string;
  sourceSlug: string;
  sourceName: string;
  isSample: boolean;
  title: string;
  productName: string;
  brand: string;
  productUrl: string;
  sellerName: string | null;
  stockStatus: StockStatus;
  launchDate: string | null;
  variantAttributes: Record<string, unknown>;
  specifications: Record<string, unknown>;
  offerConditions: Record<string, unknown>;
  observedAt: string;
  /** Computed by the pricing engine from the database (never from the caller). */
  pricing: PricingResult;
}

export class InternalIntelligence {
  readonly pricing: PricingService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly importer: CatalogImporter,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.pricing = new PricingService(prisma, now);
  }

  /** Normalization only (no persistence): what the catalog would derive. */
  normalize(items: NormalizedProduct[], categorySlug?: string) {
    return items.map((item, index) => {
      try {
        const listing = sourceListingSchema.parse(toSourceListing(item, categorySlug));
        const n = normalizeListing(listing);
        return {
          index,
          ok: true as const,
          sourceId: item.sourceId,
          externalId: item.externalId,
          brand: n.brand,
          brandKey: n.brandKey,
          name: n.name,
          normalizedName: n.normalizedName,
          modelNumber: n.modelNumber,
          attributes: n.attributes,
          variantKey: n.variantKey,
          discriminators: n.discriminators,
        };
      } catch (err) {
        return {
          index,
          ok: false as const,
          sourceId: item.sourceId,
          externalId: item.externalId,
          error: (err as Error).message.slice(0, 300),
        };
      }
    });
  }

  /**
   * Deduplication through the catalog matching engine: listings are matched
   * (identifier → model → title → trigram, variant-safe) and persisted as shared
   * offers. Uncertain matches go to manual review and are not grouped.
   */
  async deduplicate(items: NormalizedProduct[], categorySlug?: string) {
    const outcomes: {
      index: number;
      status: "imported" | "review" | "rejected" | "not_storable";
      productId?: string;
      variantId?: string;
      offerId?: string;
      method?: string;
      confidence?: number;
      reason?: string;
    }[] = [];
    const bySource = new Map<string, { index: number; item: NormalizedProduct }[]>();
    items.forEach((item, index) => {
      if (item.priceType === "INDICATIVE") {
        outcomes.push({
          index,
          status: "not_storable",
          reason: "Indicative (discovery) price is not an offer",
        });
        return;
      }
      const list = bySource.get(item.sourceId) ?? [];
      list.push({ index, item });
      bySource.set(item.sourceId, list);
    });
    for (const [sourceId, list] of bySource) {
      const summary = await this.importer.importListings(
        sourceId,
        list.map((x) => toSourceListing(x.item, categorySlug)),
      );
      for (const o of summary.outcomes) {
        const index = list[o.index]!.index;
        if (o.status === "imported") {
          outcomes.push({
            index,
            status: "imported",
            productId: o.productId,
            variantId: o.variantId,
            offerId: o.offerId,
            method: o.method,
            confidence: o.confidence,
          });
        } else if (o.status === "review") {
          outcomes.push({
            index,
            status: "review",
            confidence: o.confidence,
            reason: "Uncertain match held for manual review",
          });
        } else {
          outcomes.push({
            index,
            status: "rejected",
            reason: JSON.stringify(o.issues).slice(0, 300),
          });
        }
      }
    }
    outcomes.sort((a, b) => a.index - b.index);
    // Groups: one per product, variants never merged.
    const groups = new Map<string, Map<string, string[]>>();
    for (const o of outcomes) {
      if (o.status !== "imported") continue;
      const variants = groups.get(o.productId!) ?? new Map<string, string[]>();
      variants.set(o.variantId!, [...new Set([...(variants.get(o.variantId!) ?? []), o.offerId!])]);
      groups.set(o.productId!, variants);
    }
    return {
      outcomes,
      groups: [...groups].map(([productId, variants]) => ({
        productId,
        variants: [...variants].map(([variantId, offerIds]) => ({ variantId, offerIds })),
      })),
    };
  }

  /** Facts + deterministic pricing for offers (from the database, never from the caller). */
  async offerFacts(
    offerIds: string[],
    eligibility: EligibilityContext = {},
  ): Promise<OfferFacts[]> {
    return this.toFacts(await this.pricing.candidates(offerIds, eligibility));
  }

  private async toFacts(candidates: RankCandidate[]): Promise<OfferFacts[]> {
    if (!candidates.length) return [];
    const meta = await this.prisma.productOffer.findMany({
      where: { id: { in: candidates.map((c) => c.offerId) } },
      select: {
        id: true,
        productUrl: true,
        sellerName: true,
        offerConditions: true,
        source: { select: { isSample: true } },
      },
    });
    const byId = new Map(meta.map((m) => [m.id, m]));
    return candidates.map((c) => {
      const m = byId.get(c.offerId)!;
      return {
        offerId: c.offerId,
        productId: c.productId,
        variantId: c.variantId,
        sourceSlug: c.sourceSlug,
        sourceName: c.sourceName,
        isSample: m.source.isSample,
        title: c.title,
        productName: c.productName,
        brand: c.brand,
        productUrl: m.productUrl,
        sellerName: m.sellerName,
        stockStatus: c.stockStatus,
        launchDate: c.launchDate?.toISOString() ?? null,
        variantAttributes: c.variantAttributes,
        specifications: c.specifications,
        offerConditions: (m.offerConditions ?? {}) as Record<string, unknown>,
        observedAt: c.pricing.observedAt,
        pricing: c.pricing,
      };
    });
  }

  /** Deterministic ranking; each ranked deal also carries its offer facts. */
  async rank(
    offerIds: string[],
    options: Omit<RankingOptions, "now"> & { eligibility?: EligibilityContext },
  ) {
    const { eligibility, ...rest } = options;
    const candidates = await this.pricing.candidates(offerIds, eligibility ?? {});
    const result = rankOffers(candidates, { ...rest, now: this.now() });
    const ranked = new Set(result.ranked.map((d) => d.offerId));
    const facts = new Map(
      (await this.toFacts(candidates.filter((c) => ranked.has(c.offerId)))).map((f) => [
        f.offerId,
        f,
      ]),
    );
    const known = new Set(candidates.map((c) => c.offerId));
    return {
      ...result,
      ranked: result.ranked.map((d) => ({ ...d, offer: facts.get(d.offerId)! })),
      unknownOfferIds: [...new Set(offerIds)].filter((id) => !known.has(id)),
    };
  }
}
