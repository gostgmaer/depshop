/**
 * Deterministic intelligence exposed to the Python agent. Every number the
 * agent receives is computed here from source/database data; the agent can
 * only reference offers by id, never supply prices.
 */
import { normalizeListing, sourceListingSchema } from "@dealmind/catalog";
import { type NormalizedProduct, toSourceListing } from "@dealmind/connectors";
import type { PrismaClient } from "@dealmind/db";
import {
  type DealCandidate,
  type PriceAssessment,
  type SortMode,
  assessPrice,
  rankDeals,
  type CatalogImporter,
} from "@dealmind/intelligence";
import { paiseFromDb, paiseFromDbOrNull } from "@dealmind/shared";

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
  stockStatus: DealCandidate["stockStatus"];
  launchDate: string | null;
  variantAttributes: Record<string, unknown>;
  specifications: Record<string, unknown>;
  offerConditions: Record<string, unknown>;
  observedAt: string;
  pricing: PriceAssessment;
}

export class InternalIntelligence {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly importer: CatalogImporter,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
  async offerFacts(offerIds: string[]): Promise<OfferFacts[]> {
    const now = this.now();
    const since = new Date(now.getTime() - 90 * 86_400_000);
    const offers = await this.prisma.productOffer.findMany({
      where: { id: { in: [...new Set(offerIds)] } },
      include: {
        source: { select: { slug: true, name: true, isSample: true } },
        product: { select: { name: true, brand: true, launchDate: true, specifications: true } },
        variant: { select: { attributes: true } },
        snapshots: {
          where: { observedAt: { gte: since } },
          orderBy: { observedAt: "asc" },
          take: 2_000,
        },
      },
    });
    return offers.map((o) => ({
      offerId: o.id,
      productId: o.productId,
      variantId: o.variantId,
      sourceSlug: o.source.slug,
      sourceName: o.source.name,
      isSample: o.source.isSample,
      title: o.title,
      productName: o.product.name,
      brand: o.product.brand,
      productUrl: o.productUrl,
      sellerName: o.sellerName,
      stockStatus: o.stockStatus,
      launchDate: o.product.launchDate?.toISOString() ?? null,
      variantAttributes: (o.variant.attributes ?? {}) as Record<string, unknown>,
      specifications: (o.product.specifications ?? {}) as Record<string, unknown>,
      offerConditions: (o.offerConditions ?? {}) as Record<string, unknown>,
      observedAt: o.observedAt.toISOString(),
      pricing: assessPrice(
        {
          sellingPricePaise: paiseFromDb(o.sellingPricePaise),
          mrpPaise: paiseFromDbOrNull(o.mrpPaise),
          shippingPaise: paiseFromDbOrNull(o.shippingPaise),
        },
        o.snapshots.map((s) => ({
          sellingPricePaise: paiseFromDb(s.sellingPricePaise),
          observedAt: s.observedAt,
        })),
        now,
      ),
    }));
  }

  async rank(query: string, mode: SortMode, offerIds: string[]) {
    const facts = await this.offerFacts(offerIds);
    const ranked = rankDeals(
      query,
      facts.map((f) => ({
        id: f.offerId,
        title: f.title,
        productId: f.productId,
        variantId: f.variantId,
        sourceId: f.sourceSlug,
        stockStatus: f.stockStatus,
        launchDate: f.launchDate ? new Date(f.launchDate) : null,
        pricing: f.pricing,
        facts: f,
      })),
      mode,
    );
    return ranked.map((r) => ({
      rank: r.rank,
      score: r.score,
      breakdown: r.breakdown,
      offer: r.deal.facts,
    }));
  }
}
