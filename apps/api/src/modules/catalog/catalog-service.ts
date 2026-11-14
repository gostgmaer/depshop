/**
 * Global catalog reads: categories, products, variants, offers, price history
 * and shopping sources. This data is shared by all users and never copied per
 * user. Only offers from ENABLED sources are exposed: a disabled source has no
 * authorized integration.
 */
import { Prisma, type PrismaClient } from "@dealmind/db";
import {
  AppError,
  type CategoryNode,
  type CategoryView,
  type OfferView,
  type PageQuery,
  type ProductListQuery,
  type ProductSummary,
  discountBasisPoints,
  paise,
  paginationOf,
} from "@dealmind/shared";
import type { CacheService } from "../../lib/cache.js";
import { type Paginated, iso, paginated } from "../../utils/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CategoryRow = { id: string; slug: string; name: string; parentId: string | null };
const toCategory = (c: CategoryRow): CategoryView => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  parentId: c.parentId,
});

export class CatalogService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache: CacheService,
    private readonly ttlSeconds: number,
  ) {}

  // ── Categories ──────────────────────────────────────────────────────────

  listCategories(): Promise<CategoryView[]> {
    return this.cache.getOrSet(this.cache.catalogKey("categories"), this.ttlSeconds, async () =>
      (
        await this.prisma.category.findMany({
          orderBy: [{ name: "asc" }],
          select: { id: true, slug: true, name: true, parentId: true },
        })
      ).map(toCategory),
    );
  }

  async categoryTree(): Promise<CategoryNode[]> {
    const all = await this.listCategories();
    const nodes = new Map<string, CategoryNode>(all.map((c) => [c.id, { ...c, children: [] }]));
    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  /** The category and all of its descendants (ids). */
  private async subtreeIds(rootId: string): Promise<string[]> {
    const all = await this.listCategories();
    const ids = [rootId];
    for (let i = 0; i < ids.length; i += 1) {
      for (const c of all) if (c.parentId === ids[i]) ids.push(c.id);
    }
    return ids;
  }

  private async findCategory(idOrSlug: string): Promise<CategoryView> {
    const all = await this.listCategories();
    const category = all.find((c) => (UUID_RE.test(idOrSlug) ? c.id === idOrSlug : c.slug === idOrSlug));
    if (!category) throw AppError.notFound("Category");
    return category;
  }

  async getCategory(idOrSlug: string) {
    const category = await this.findCategory(idOrSlug);
    const all = await this.listCategories();
    const breadcrumb: CategoryView[] = [];
    for (let c: CategoryView | undefined = category; c; c = all.find((x) => x.id === c?.parentId)) {
      breadcrumb.unshift(c);
      if (breadcrumb.length > 10) break; // defensive against cycles
    }
    const productCount = await this.prisma.product.count({
      where: { categoryId: { in: await this.subtreeIds(category.id) } },
    });
    return {
      ...category,
      breadcrumb,
      children: all.filter((c) => c.parentId === category.id),
      productCount,
    };
  }

  // ── Products ────────────────────────────────────────────────────────────

  async listProducts(q: ProductListQuery): Promise<Paginated<ProductSummary>> {
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (q.category) {
      const category = await this.findCategory(q.category);
      const ids = await this.subtreeIds(category.id);
      conds.push(Prisma.sql`p."categoryId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`);
    }
    if (q.brand) conds.push(Prisma.sql`lower(p.brand) = lower(${q.brand})`);
    if (q.launchedAfter) conds.push(Prisma.sql`p."launchedAt" >= ${q.launchedAfter}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(
        Prisma.sql`(p.title ILIKE ${like} OR p.brand ILIKE ${like} OR p.model ILIKE ${like}
                   OR similarity(p.title, ${q.q}) > 0.3)`,
      );
    }
    if (q.minPricePaise != null) conds.push(Prisma.sql`lp.low >= ${q.minPricePaise}`);
    if (q.maxPricePaise != null) conds.push(Prisma.sql`lp.low <= ${q.maxPricePaise}`);

    const order = (() => {
      switch (q.sort) {
        case "newest":
          return Prisma.sql`p."launchedAt" DESC NULLS LAST, p."createdAt" DESC`;
        case "price_asc":
          return Prisma.sql`lp.low ASC NULLS LAST`;
        case "price_desc":
          return Prisma.sql`lp.low DESC NULLS LAST`;
        case "title":
          return Prisma.sql`p.title ASC`;
        default:
          return q.q ? Prisma.sql`similarity(p.title, ${q.q}) DESC` : Prisma.sql`p."createdAt" DESC`;
      }
    })();

    const rows = await this.prisma.$queryRaw<{ id: string; low: number | null; cnt: number; total: bigint }[]>`
      WITH lp AS (
        SELECT v."productId", MIN(o."pricePaise")::int AS low, COUNT(o.id)::int AS cnt
        FROM "ProductVariant" v
        JOIN "ProductOffer" o ON o."variantId" = v.id
        JOIN "ShoppingSource" s ON s.id = o."sourceId" AND s.enabled
        GROUP BY v."productId"
      )
      SELECT p.id, lp.low, COALESCE(lp.cnt, 0)::int AS cnt, COUNT(*) OVER () AS total
      FROM "Product" p LEFT JOIN lp ON lp."productId" = p.id
      WHERE ${Prisma.join(conds, " AND ")}
      ORDER BY ${order}, p.id
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;

    const total = Number(rows[0]?.total ?? 0);
    const products = await this.prisma.product.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      include: { category: { select: { id: true, slug: true, name: true, parentId: true } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = rows.flatMap((r) => {
      const p = byId.get(r.id);
      return p ? [this.summary(p, r.low, r.cnt)] : [];
    });
    return paginated(items, paginationOf(q as PageQuery, total));
  }

  private summary(
    p: {
      id: string;
      title: string;
      brand: string;
      model: string | null;
      imageUrl: string | null;
      launchedAt: Date | null;
      category: CategoryRow | null;
    },
    low: number | null,
    offerCount: number,
  ): ProductSummary {
    return {
      id: p.id,
      title: p.title,
      brand: p.brand,
      model: p.model,
      imageUrl: p.imageUrl,
      category: p.category ? toCategory(p.category) : null,
      launchedAt: iso(p.launchedAt),
      lowestPricePaise: low,
      offerCount,
    };
  }

  private async lowestPrice(productId: string): Promise<{ low: number | null; count: number }> {
    const agg = await this.prisma.productOffer.aggregate({
      where: { variant: { productId }, source: { enabled: true } },
      _min: { pricePaise: true },
      _count: { _all: true },
    });
    return { low: agg._min.pricePaise, count: agg._count._all };
  }

  async getProduct(id: string) {
    return this.cache.getOrSet(this.cache.catalogKey("product", id), this.ttlSeconds, async () => {
      const p = await this.prisma.product.findUnique({
        where: { id },
        include: {
          category: { select: { id: true, slug: true, name: true, parentId: true } },
          variants: { orderBy: { variantKey: "asc" } },
        },
      });
      if (!p) throw AppError.notFound("Product");
      const { low, count } = await this.lowestPrice(id);
      return {
        ...this.summary(p, low, count),
        specs: (p.specs ?? {}) as Record<string, unknown>,
        variants: p.variants.map((v) => ({
          id: v.id,
          variantKey: v.variantKey,
          attributes: (v.attributes ?? {}) as Record<string, unknown>,
          gtin: v.gtin,
        })),
      };
    });
  }

  async getVariants(productId: string) {
    return (await this.getProduct(productId)).variants;
  }

  async getOffers(productId: string, variantId?: string): Promise<OfferView[]> {
    await this.assertProduct(productId);
    const offers = await this.prisma.productOffer.findMany({
      where: {
        variant: { productId },
        ...(variantId ? { variantId } : {}),
        source: { enabled: true },
      },
      include: { source: { select: { id: true, code: true, name: true } } },
      orderBy: [{ pricePaise: "asc" }, { id: "asc" }],
      take: 200,
    });
    return offers.map((o) => toOfferView(o));
  }

  async getPriceHistory(productId: string, days: number, variantId?: string) {
    await this.assertProduct(productId);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const snapshots = await this.prisma.priceSnapshot.findMany({
      where: {
        capturedAt: { gte: from },
        offer: {
          variant: { productId },
          ...(variantId ? { variantId } : {}),
          source: { enabled: true },
        },
      },
      include: { offer: { select: { id: true, source: { select: { code: true } } } } },
      orderBy: { capturedAt: "asc" },
      take: 5_000,
    });
    const prices = snapshots.map((s) => s.pricePaise);
    return {
      productId,
      from: from.toISOString(),
      to: to.toISOString(),
      points: snapshots.map((s) => ({
        offerId: s.offer.id,
        sourceCode: s.offer.source.code,
        pricePaise: s.pricePaise,
        mrpPaise: s.mrpPaise,
        availability: s.availability,
        capturedAt: s.capturedAt.toISOString(),
      })),
      lowestPricePaise: prices.length ? Math.min(...prices) : null,
      highestPricePaise: prices.length ? Math.max(...prices) : null,
    };
  }

  private async assertProduct(id: string): Promise<void> {
    const exists = await this.prisma.product.count({ where: { id } });
    if (!exists) throw AppError.notFound("Product");
  }

  // ── Shopping sources ────────────────────────────────────────────────────

  private sourceView(s: {
    id: string;
    code: string;
    name: string;
    baseUrl: string;
    integrationKind: string;
    enabled: boolean;
    health: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "DOWN";
    lastHealthCheckAt: Date | null;
  }) {
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      baseUrl: s.baseUrl,
      integrationKind: s.integrationKind,
      enabled: s.enabled,
      available: s.enabled && s.health !== "DOWN",
      health: s.health,
      lastHealthCheckAt: iso(s.lastHealthCheckAt),
    };
  }

  private readonly sourceSelect = {
    id: true,
    code: true,
    name: true,
    baseUrl: true,
    integrationKind: true,
    enabled: true,
    health: true,
    lastHealthCheckAt: true,
  } as const;

  async listEnabledSources() {
    const rows = await this.prisma.shoppingSource.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
      select: this.sourceSelect,
    });
    return rows.map((s) => this.sourceView(s));
  }

  async getSource(code: string) {
    const s = await this.prisma.shoppingSource.findUnique({ where: { code }, select: this.sourceSelect });
    if (!s) throw AppError.notFound("Source");
    return this.sourceView(s);
  }

  /** Integration status of every registered source (no credentials or config). */
  async sourceStatus() {
    const rows = await this.prisma.shoppingSource.findMany({ orderBy: { name: "asc" }, select: this.sourceSelect });
    return {
      totalSources: rows.length,
      enabledSources: rows.filter((s) => s.enabled).length,
      healthySources: rows.filter((s) => s.enabled && s.health === "HEALTHY").length,
      sources: rows.map((s) => ({
        code: s.code,
        name: s.name,
        enabled: s.enabled,
        integrationKind: s.integrationKind,
        health: s.health,
        lastHealthCheckAt: iso(s.lastHealthCheckAt),
      })),
    };
  }
}

export function toOfferView(o: {
  id: string;
  variantId: string;
  title: string;
  url: string;
  sellerName: string | null;
  pricePaise: number;
  mrpPaise: number | null;
  availability: string;
  lastSeenAt: Date;
  source: { id: string; code: string; name: string };
}): OfferView {
  return {
    id: o.id,
    variantId: o.variantId,
    source: o.source,
    title: o.title,
    url: o.url,
    sellerName: o.sellerName,
    pricePaise: o.pricePaise,
    mrpPaise: o.mrpPaise,
    discountBasisPoints: discountBasisPoints(paise(o.pricePaise), o.mrpPaise == null ? null : paise(o.mrpPaise)),
    availability: o.availability,
    lastSeenAt: o.lastSeenAt.toISOString(),
  };
}
