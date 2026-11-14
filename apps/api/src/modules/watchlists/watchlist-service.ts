/**
 * User-owned watchlists of shared catalog variants (never copied per user).
 * Every query filters by the authenticated userId; the database additionally
 * enforces ownership with the composite FK (watchlistId, userId).
 */
import { type PrismaClient, isUniqueViolation } from "@dealmind/db";
import { AppError, type PageQuery, paginationOf, paiseFromDb } from "@dealmind/shared";
import { paginated } from "../../utils/http.js";
import { toVariantView } from "../catalog/catalog-service.js";
import type { PlanService } from "../subscriptions/plan-service.js";

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

export class WatchlistService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly plans: PlanService,
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
    await this.plans.assertWithinLimit(userId, "watchlists");
    try {
      const w = await this.prisma.watchlist.create({
        data: { userId, name },
        include: { _count: { select: { items: true } } },
      });
      return this.view(w);
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict("You already have a watchlist with this name");
      throw err;
    }
  }

  async list(userId: string, q: PageQuery) {
    const where = { userId };
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
    const lows = await this.lowestPrices(items.map((i) => i.variant.id));
    return {
      ...this.view(w),
      items: items.map((i) => ({
        id: i.id,
        note: i.note,
        addedAt: i.addedAt.toISOString(),
        variant: toVariantView(i.variant),
        product: i.variant.product,
        lowestPricePaise: lows.get(i.variant.id) ?? null,
      })),
    };
  }

  private async lowestPrices(variantIds: string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.prisma.productOffer.groupBy({
      by: ["variantId"],
      where: {
        variantId: { in: variantIds },
        source: { status: "ACTIVE" },
        observedAt: { gte: new Date(Date.now() - this.offerStaleAfterMs) },
      },
      _min: { sellingPricePaise: true },
    });
    return new Map(
      rows.flatMap((r) => {
        const low = r._min?.sellingPricePaise;
        return low == null ? [] : [[r.variantId, paiseFromDb(low)] as const];
      }),
    );
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
      await this.prisma.watchlistItem.create({
        data: { userId, watchlistId, variantId, note: note ?? null },
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
