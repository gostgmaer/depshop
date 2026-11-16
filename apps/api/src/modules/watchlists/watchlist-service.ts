/**
 * User-owned watchlists of shared catalog variants (never copied per user).
 * Every query filters by the authenticated userId; the database additionally
 * enforces ownership with the composite FK (watchlistId, userId).
 */
import { type PrismaClient, isUniqueViolation } from "@dealmind/db";
import {
  AppError,
  type PageQuery,
  paginationOf,
  paiseFromDb,
  signedRatioBp,
} from "@dealmind/shared";
import { paginated } from "../../utils/http.js";
import { toVariantView } from "../catalog/catalog-service.js";
import type { EntitlementService } from "@dealmind/billing";

const itemInclude = {
  variant: {
    select: {
      id: true,
      variantKey: true,
      attributes: true,
      sku: true,
      gtin: true,
      product: { select: { id: true, name: true, brand: true, imageUrl: true } },
    },
  },
} as const;

const DAY = 86_400_000;
const MOVEMENT_DAYS = 7 as const;

export class WatchlistService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly entitlements: EntitlementService,
    /** Offers not observed for this long are excluded from lowest prices. */
    private readonly offerStaleAfterMs = 24 * 3_600_000,
  ) {}

  private view(w: {
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    _count: { items: number };
  }) {
    return {
      id: w.id,
      name: w.name,
      itemCount: w._count.items,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  private async owned(userId: string, id: string) {
    const w = await this.prisma.watchlist.findFirst({
      where: { id, userId },
      include: { _count: { select: { items: true } } },
    });
    if (!w) throw AppError.notFound("Watchlist");
    return w;
  }

  async create(userId: string, name: string) {
    try {
      const w = await this.prisma.$transaction(async (tx) => {
        await this.entitlements.enforceGauge(
          tx,
          userId,
          "watchlists",
          this.entitlements.gaugeCounts(tx, userId).watchlists,
        );
        return tx.watchlist.create({
          data: { userId, name },
          include: { _count: { select: { items: true } } },
        });
      });
      return this.view(w);
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict("You already have a watchlist with this name");
      throw err;
    }
  }

  async list(userId: string, q: PageQuery & { variantId?: string | undefined }) {
    const where = {
      userId,
      ...(q.variantId ? { items: { some: { userId, variantId: q.variantId } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.watchlist.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.watchlist.count({ where }),
    ]);
    return paginated(
      rows.map((w) => this.view(w)),
      paginationOf(q, total),
    );
  }

  async get(userId: string, id: string) {
    const w = await this.owned(userId, id);
    const items = await this.prisma.watchlistItem.findMany({
      where: { watchlistId: id, userId },
      orderBy: { addedAt: "desc" },
      include: itemInclude,
    });
    const variantIds = items.map((i) => i.variant.id);
    const [current, before] = await Promise.all([
      this.currentLows(variantIds),
      this.lowsAt(variantIds, new Date(Date.now() - MOVEMENT_DAYS * DAY)),
    ]);
    return {
      ...this.view(w),
      items: items.map((i) => {
        const cur = current.get(i.variant.id) ?? null;
        const prev = before.get(i.variant.id) ?? null;
        return {
          id: i.id,
          note: i.note,
          addedAt: i.addedAt.toISOString(),
          variant: toVariantView(i.variant),
          product: i.variant.product,
          lowestPricePaise: cur ? paiseFromDb(cur.deliveredPaise) : null,
          current: cur
            ? {
                deliveredPaise: paiseFromDb(cur.deliveredPaise),
                marketplace: cur.marketplace,
                observedAt: cur.observedAt.toISOString(),
                offerCount: cur.offerCount,
              }
            : null,
          movement:
            cur && prev !== null
              ? {
                  days: MOVEMENT_DAYS,
                  previousPaise: paiseFromDb(prev),
                  changePaise: paiseFromDb(cur.deliveredPaise) - paiseFromDb(prev),
                  changeBp: signedRatioBp(cur.deliveredPaise - prev, prev),
                }
              : null,
        };
      }),
    };
  }

  /** Lowest delivered price per variant among fresh, available offers of ACTIVE sources. */
  private async currentLows(variantIds: string[]) {
    const out = new Map<
      string,
      {
        deliveredPaise: bigint;
        marketplace: { slug: string; name: string };
        observedAt: Date;
        offerCount: number;
      }
    >();
    if (!variantIds.length) return out;
    const offers = await this.prisma.productOffer.findMany({
      where: {
        variantId: { in: variantIds },
        source: { status: "ACTIVE" },
        observedAt: { gte: new Date(Date.now() - this.offerStaleAfterMs) },
        stockStatus: { in: ["IN_STOCK", "LIMITED"] },
        trackingState: "ACTIVE",
      },
      select: {
        variantId: true,
        sellingPricePaise: true,
        shippingPaise: true,
        observedAt: true,
        source: { select: { slug: true, name: true } },
      },
    });
    for (const o of offers) {
      const delivered = o.sellingPricePaise + (o.shippingPaise ?? 0n);
      const prev = out.get(o.variantId);
      if (!prev)
        out.set(o.variantId, {
          deliveredPaise: delivered,
          marketplace: o.source,
          observedAt: o.observedAt,
          offerCount: 1,
        });
      else {
        prev.offerCount += 1;
        if (delivered < prev.deliveredPaise)
          Object.assign(prev, {
            deliveredPaise: delivered,
            marketplace: o.source,
            observedAt: o.observedAt,
          });
      }
    }
    return out;
  }

  /**
   * Lowest delivered price per variant as of `at`: each offer's last snapshot
   * at or before `at` (within the stale window before it), lowest across
   * offers. Variants with no such observation are absent (never estimated).
   */
  private async lowsAt(variantIds: string[], at: Date): Promise<Map<string, bigint>> {
    if (!variantIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ variantId: string; low: bigint }[]>`
      SELECT o."variantId", MIN(s."sellingPricePaise" + COALESCE(s."shippingPaise", 0)) AS low
      FROM "ProductOffer" o
      JOIN "ShoppingSource" src ON src.id = o."sourceId" AND src.status = 'ACTIVE'
      JOIN LATERAL (
        SELECT ps."sellingPricePaise", ps."shippingPaise", ps."stockStatus"
        FROM "PriceSnapshot" ps
        WHERE ps."offerId" = o.id AND ps."observedAt" <= ${at}
          AND ps."observedAt" >= ${new Date(at.getTime() - this.offerStaleAfterMs)}
        ORDER BY ps."observedAt" DESC
        LIMIT 1
      ) s ON s."stockStatus" IN ('IN_STOCK', 'LIMITED')
      WHERE o."variantId" = ANY(${variantIds}::uuid[])
      GROUP BY o."variantId"`;
    return new Map(rows.map((r) => [r.variantId, r.low]));
  }

  async rename(userId: string, id: string, name: string) {
    await this.owned(userId, id);
    try {
      await this.prisma.watchlist.update({ where: { id }, data: { name } });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict("You already have a watchlist with this name");
      throw err;
    }
    return this.view(await this.owned(userId, id));
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.prisma.watchlist.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw AppError.notFound("Watchlist");
  }

  async addItem(userId: string, watchlistId: string, variantId: string, note?: string) {
    await this.owned(userId, watchlistId);
    const variant = await this.prisma.productVariant.count({ where: { id: variantId } });
    if (!variant) throw AppError.notFound("Product variant");
    try {
      await this.prisma.$transaction(async (tx) => {
        // Bulk tracking: products across all watchlists, per plan.
        await this.entitlements.enforceGauge(
          tx,
          userId,
          "trackedProducts",
          this.entitlements.gaugeCounts(tx, userId).trackedProducts,
        );
        await tx.watchlistItem.create({
          data: { userId, watchlistId, variantId, note: note ?? null },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict("This product is already in the watchlist");
      throw err;
    }
    return this.get(userId, watchlistId);
  }

  async removeItem(userId: string, watchlistId: string, itemId: string): Promise<void> {
    const res = await this.prisma.watchlistItem.deleteMany({
      where: { id: itemId, watchlistId, userId },
    });
    if (res.count === 0) throw AppError.notFound("Watchlist item");
  }
}
