/**
 * Database-backed pricing/ranking service. Every price comes from the shared
 * catalog (ProductOffer + append-only PriceSnapshot); callers pass offer ids
 * and the user's stated eligibility, never prices.
 */
import type { PrismaClient } from "@dealmind/db";
import { paiseFromDb, paiseFromDbOrNull } from "@dealmind/shared";
import { compareOffers, rankOffers } from "../ranking/engine.js";
import type { RankCandidate, RankingOptions } from "../ranking/types.js";
import { type PricingResult, calculatePricing } from "./engine.js";
import {
  DEFAULT_HISTORY_OPTIONS,
  type PriceHistoryStats,
  priceHistory,
} from "./historical-prices/history.js";
import type { EligibilityContext } from "./schemas/offer-conditions.js";

const DAY = 86_400_000;
/** Longest history window used by pricing (DEFAULT_HISTORY_OPTIONS.windowsDays max). */
const HISTORY_DAYS = Math.max(...DEFAULT_HISTORY_OPTIONS.windowsDays);
const MAX_SNAPSHOTS = 5_000;

export class OfferNotFoundError extends Error {
  override readonly name = "OfferNotFoundError";
}

export class PricingService {
  private categoryPaths: { at: number; byId: Map<string, string[]> } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Category id → slugs from the category up to the root (cached 5 minutes). */
  private async paths(): Promise<Map<string, string[]>> {
    const t = Date.now();
    if (this.categoryPaths && t - this.categoryPaths.at < 300_000) return this.categoryPaths.byId;
    const rows = await this.prisma.category.findMany({
      select: { id: true, slug: true, parentId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const path: string[] = [];
      let cur: (typeof rows)[number] | undefined = r;
      for (let depth = 0; cur && depth < 20; depth++) {
        path.push(cur.slug);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      out.set(r.id, path);
    }
    this.categoryPaths = { at: t, byId: out };
    return out;
  }

  /** Offers with pricing computed now; unknown ids are simply absent (order of `offerIds`). */
  async candidates(
    offerIds: string[],
    eligibility: EligibilityContext = {},
  ): Promise<RankCandidate[]> {
    const now = this.now();
    const ids = [...new Set(offerIds)];
    if (!ids.length) return [];
    const since = new Date(now.getTime() - HISTORY_DAYS * DAY);
    const [offers, paths] = await Promise.all([
      this.prisma.productOffer.findMany({
        where: { id: { in: ids } },
        include: {
          source: { select: { slug: true, name: true } },
          product: {
            select: {
              name: true,
              brand: true,
              launchDate: true,
              specifications: true,
              categoryId: true,
            },
          },
          variant: { select: { attributes: true } },
        },
      }),
      this.paths(),
    ]);
    // One query for every offer's history (index: offerId, observedAt desc).
    const snaps = await this.prisma.priceSnapshot.findMany({
      where: { offerId: { in: offers.map((o) => o.id) }, observedAt: { gte: since } },
      select: { offerId: true, sellingPricePaise: true, observedAt: true },
      orderBy: { observedAt: "asc" },
      take: MAX_SNAPSHOTS * Math.max(1, offers.length),
    });
    const byOffer = new Map<string, { sellingPricePaise: bigint; observedAt: Date }[]>();
    for (const s of snaps) {
      const list = byOffer.get(s.offerId) ?? [];
      list.push(s);
      byOffer.set(s.offerId, list);
    }
    const byId = new Map(
      offers.map((o) => {
        const pricing: PricingResult = calculatePricing(
          {
            offerId: o.id,
            sellingPricePaise: o.sellingPricePaise,
            mrpPaise: o.mrpPaise,
            shippingPaise: o.shippingPaise,
            offerConditions: o.offerConditions,
            observedAt: o.observedAt,
            stockStatus: o.stockStatus,
            launchDate: o.product.launchDate,
            snapshots: (byOffer.get(o.id) ?? []).slice(-MAX_SNAPSHOTS),
          },
          eligibility,
          now,
        );
        const candidate: RankCandidate = {
          offerId: o.id,
          productId: o.productId,
          variantId: o.variantId,
          sourceSlug: o.source.slug,
          sourceName: o.source.name,
          title: o.title,
          productName: o.product.name,
          brand: o.product.brand,
          categoryPath: o.product.categoryId ? (paths.get(o.product.categoryId) ?? []) : [],
          stockStatus: o.stockStatus,
          launchDate: o.product.launchDate,
          variantAttributes: (o.variant.attributes ?? {}) as Record<string, unknown>,
          specifications: (o.product.specifications ?? {}) as Record<string, unknown>,
          pricing,
        };
        return [o.id, candidate] as const;
      }),
    );
    return ids.flatMap((id) => {
      const c = byId.get(id);
      return c ? [c] : [];
    });
  }

  async calculate(
    offerIds: string[],
    eligibility: EligibilityContext = {},
  ): Promise<PricingResult[]> {
    return (await this.candidates(offerIds, eligibility)).map((c) => c.pricing);
  }

  async rank(
    offerIds: string[],
    options: Omit<RankingOptions, "now"> & { eligibility?: EligibilityContext },
  ) {
    const { eligibility, ...rest } = options;
    const candidates = await this.candidates(offerIds, eligibility ?? {});
    const result = rankOffers(candidates, { ...rest, now: this.now() });
    const known = new Set(candidates.map((c) => c.offerId));
    const unknown = [...new Set(offerIds)].filter((id) => !known.has(id));
    return { ...result, unknownOfferIds: unknown };
  }

  async compare(offerIds: string[], eligibility: EligibilityContext = {}) {
    return compareOffers(await this.candidates(offerIds, eligibility));
  }

  /** History analytics and the raw observations (newest last) for one offer. */
  async history(
    offerId: string,
    days = HISTORY_DAYS,
  ): Promise<{
    offerId: string;
    stats: PriceHistoryStats;
    series: {
      sellingPricePaise: number;
      mrpPaise: number | null;
      stockStatus: string;
      observedAt: string;
    }[];
  }> {
    const now = this.now();
    const offer = await this.prisma.productOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        sellingPricePaise: true,
        observedAt: true,
        product: { select: { launchDate: true } },
      },
    });
    if (!offer) throw new OfferNotFoundError(offerId);
    const snaps = await this.prisma.priceSnapshot.findMany({
      where: { offerId, observedAt: { gte: new Date(now.getTime() - days * DAY) } },
      orderBy: { observedAt: "desc" },
      take: MAX_SNAPSHOTS,
    });
    snaps.reverse();
    const stats = priceHistory(
      {
        currentPaise: offer.sellingPricePaise,
        currentObservedAt: offer.observedAt,
        snapshots: snaps,
        launchDate: offer.product.launchDate,
      },
      now,
      { windowsDays: DEFAULT_HISTORY_OPTIONS.windowsDays.filter((d) => d <= days) },
    );
    return {
      offerId,
      stats,
      series: snaps.map((s) => ({
        sellingPricePaise: paiseFromDb(s.sellingPricePaise),
        mrpPaise: paiseFromDbOrNull(s.mrpPaise),
        stockStatus: s.stockStatus,
        observedAt: s.observedAt.toISOString(),
      })),
    };
  }
}
