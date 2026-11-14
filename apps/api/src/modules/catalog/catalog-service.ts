/**
 * Global catalog reads: categories, products, variants, offers, price history
 * and shopping sources. Shared by all users; never copied per user.
 *
 * Offer rules:
 *  - only offers from ACTIVE sources are exposed (others have no authorized integration);
 *  - an offer not observed within `offerStaleAfterMs` is stale: it is excluded
 *    from lowest-price summaries and, when listed on request, flagged `isStale`;
 *  - offers from a sample source are flagged (`source.isSample`, `sampleData`).
 *
 * Caching (Redis, shared `catalog:*` keys, explicit TTLs, invalidated on import):
 *  - category list ............ ttl.categories
 *  - product detail (static) .. ttl.product
 *  - offer summaries & lists .. ttl.offers (short; freshness cut-off is shifted
 *    by this TTL so a cached value can never show an offer older than the stale limit)
 *  - price history ............ ttl.history
 */
// Same canonicalization the importer applies (brand filter must match stored brands).
import { PRODUCT_CACHE_KINDS, normalizeBrand } from "@dealmind/catalog";
import { type MetricsStore, type SourceMetrics, effectiveStatus } from "@dealmind/connectors";
import { Prisma, type PrismaClient } from "@dealmind/db";
import {
  AppError,
  type CategoryNode,
  type CategoryView,
  type OfferView,
  type PageQuery,
  type ProductListQuery,
  type ProductSummary,
  type VariantView,
  discountBasisPoints,
  paiseFromDb,
  paiseFromDbOrNull,
  paginationOf,
} from "@dealmind/shared";
import type { CacheService } from "../../lib/cache.js";
import { type Paginated, iso, paginated } from "../../utils/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CatalogCacheTtls {
  categories: number;
  product: number;
  offers: number;
  history: number;
}

export interface CatalogOptions {
  ttl: CatalogCacheTtls;
  /** Offers not observed for this long are stale (never shown as live). */
  offerStaleAfterMs: number;
  /** Connector execution metrics (shared Redis store written by the worker). */
  metrics?: MetricsStore;
  now?: () => Date;
}

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  parentId: string | null;
};
const categorySelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  imageUrl: true,
  parentId: true,
} as const;
const toCategory = (c: CategoryRow): CategoryView => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  description: c.description,
  imageUrl: c.imageUrl,
  parentId: c.parentId,
});

interface OfferSummary {
  low: number | null;
  count: number;
  inStock: boolean;
  sampleData: boolean;
}

type ProductCore = Omit<
  ProductSummary,
  "lowestPricePaise" | "offerCount" | "inStock" | "sampleData"
>;

const IN_STOCK = Prisma.sql`o."stockStatus" IN ('IN_STOCK', 'LIMITED')`;

export class CatalogService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache: CacheService,
    private readonly options: CatalogOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    return ttl > 0 ? this.cache.getOrSet(key, ttl, load) : load();
  }

  /** Observed-at cut-off for "fresh" offers, shifted by the offer cache TTL. */
  private freshCutoff(): Date {
    return new Date(
      this.now().getTime() - this.options.offerStaleAfterMs + this.options.ttl.offers * 1000,
    );
  }

  private isStale(observedAt: string | Date): boolean {
    return this.now().getTime() - new Date(observedAt).getTime() > this.options.offerStaleAfterMs;
  }

  // ── Cache invalidation ──────────────────────────────────────────────────

  async invalidateProducts(productIds: string[]): Promise<void> {
    // Same key scheme as @dealmind/catalog invalidateProductCaches (used by importers).
    await Promise.all(
      productIds.flatMap((id) =>
        PRODUCT_CACHE_KINDS.map((kind) => this.cache.delPrefix(this.cache.catalogKey(kind, id))),
      ),
    );
  }

  invalidateCategories(): Promise<void> {
    return this.cache.del(this.cache.catalogKey("categories"));
  }

  // ── Categories ──────────────────────────────────────────────────────────

  /** Active categories (inactive ones are hidden from browsing). */
  listCategories(): Promise<CategoryView[]> {
    return this.cached(this.cache.catalogKey("categories"), this.options.ttl.categories, async () =>
      (
        await this.prisma.category.findMany({
          where: { isActive: true },
          orderBy: [{ name: "asc" }],
          select: categorySelect,
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
      // A child of an inactive category is not reachable from the tree.
      if (node.parentId && !parent) continue;
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
    const category = all.find((c) =>
      UUID_RE.test(idOrSlug) ? c.id === idOrSlug : c.slug === idOrSlug,
    );
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
      where: { isActive: true, categoryId: { in: await this.subtreeIds(category.id) } },
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
    const conds: Prisma.Sql[] = [Prisma.sql`p."isActive"`];
    if (q.category) {
      const category = await this.findCategory(q.category);
      const ids = await this.subtreeIds(category.id);
      conds.push(
        Prisma.sql`p."categoryId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    }
    if (q.brand) conds.push(Prisma.sql`lower(p.brand) = lower(${normalizeBrand(q.brand)})`);
    if (q.launchedAfter) conds.push(Prisma.sql`p."launchDate" >= ${q.launchedAfter}`);
    if (q.launchedBefore) conds.push(Prisma.sql`p."launchDate" <= ${q.launchedBefore}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(
        Prisma.sql`(p.name ILIKE ${like} OR p.brand ILIKE ${like} OR p."modelNumber" ILIKE ${like}
                   OR p."normalizedName" % lower(${q.q}))`,
      );
    }
    if (q.spec && Object.keys(q.spec).length) {
      // One variant must satisfy every filter, each either on that variant's
      // attributes or on the product's specifications. Numbers match by JSONB
      // containment (GIN index), text case-insensitively.
      const perKey = Object.entries(q.spec).map(([key, value]) => {
        const json = JSON.stringify({ [key]: value });
        return Prisma.sql`(p.specifications @> ${json}::jsonb OR v.attributes @> ${json}::jsonb
          OR lower(v.attributes ->> ${key}) = lower(${String(value)})
          OR lower(p.specifications ->> ${key}) = lower(${String(value)}))`;
      });
      conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ProductVariant" v WHERE v."productId" = p.id
        AND ${Prisma.join(perKey, " AND ")})`);
    }
    if (q.minPricePaise != null) conds.push(Prisma.sql`lp.low >= ${q.minPricePaise}`);
    if (q.maxPricePaise != null) conds.push(Prisma.sql`lp.low <= ${q.maxPricePaise}`);
    if (q.inStock === true) conds.push(Prisma.sql`COALESCE(lp.in_stock, false)`);

    const order = (() => {
      switch (q.sort) {
        case "newest":
          return Prisma.sql`p."launchDate" DESC NULLS LAST, p."createdAt" DESC`;
        case "price_asc":
          return Prisma.sql`lp.low ASC NULLS LAST`;
        case "price_desc":
          return Prisma.sql`lp.low DESC NULLS LAST`;
        case "name":
          return Prisma.sql`lower(p.name) ASC, p.name ASC`;
        default:
          return q.q
            ? Prisma.sql`similarity(p."normalizedName", lower(${q.q})) DESC`
            : Prisma.sql`p."createdAt" DESC`;
      }
    })();

    const cutoff = this.freshCutoff();
    const aggregates = Prisma.sql`MIN(o."sellingPricePaise") AS low, COUNT(o.id)::int AS cnt,
      BOOL_OR(${IN_STOCK}) AS in_stock, BOOL_AND(s."isSample") AS all_sample
      FROM "ProductOffer" o
      JOIN "ShoppingSource" s ON s.id = o."sourceId" AND s.status = 'ACTIVE'`;
    // Plan choice (EXPLAIN ANALYZE, docs/CATALOG.md): with a selective filter a
    // per-product LATERAL lookup on (productId, sellingPricePaise) is fastest;
    // over the whole catalog a single aggregate pass wins.
    const selective = Boolean(
      q.category || q.brand || q.q || q.spec || q.launchedAfter || q.launchedBefore,
    );
    const offersJoin = selective
      ? Prisma.sql`LEFT JOIN LATERAL (SELECT ${aggregates}
          WHERE o."productId" = p.id AND o."observedAt" >= ${cutoff}) lp ON true`
      : Prisma.sql`LEFT JOIN (SELECT o."productId", ${aggregates}
          WHERE o."observedAt" >= ${cutoff} GROUP BY o."productId") lp ON lp."productId" = p.id`;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        low: bigint | null;
        cnt: number;
        in_stock: boolean | null;
        all_sample: boolean | null;
        total: bigint;
      }[]
    >`
      SELECT p.id, lp.low, COALESCE(lp.cnt, 0)::int AS cnt, lp.in_stock, lp.all_sample,
             COUNT(*) OVER () AS total
      FROM "Product" p ${offersJoin}
      WHERE ${Prisma.join(conds, " AND ")}
      ORDER BY ${order}, p.id
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;

    const total = Number(rows[0]?.total ?? 0);
    const products = await this.prisma.product.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      include: { category: { select: categorySelect } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = rows.flatMap((r) => {
      const p = byId.get(r.id);
      return p
        ? [
            {
              ...productCore(p),
              lowestPricePaise: paiseFromDbOrNull(r.low),
              offerCount: r.cnt,
              inStock: r.in_stock ?? false,
              sampleData: r.all_sample ?? false,
            },
          ]
        : [];
    });
    return paginated(items, paginationOf(q as PageQuery, total));
  }

  private offerSummary(productId: string): Promise<OfferSummary> {
    return this.cached(
      this.cache.catalogKey("offer-summary", productId),
      this.options.ttl.offers,
      async () => {
        const [row] = await this.prisma.$queryRaw<
          {
            low: bigint | null;
            cnt: number;
            in_stock: boolean | null;
            all_sample: boolean | null;
          }[]
        >`
        SELECT MIN(o."sellingPricePaise") AS low, COUNT(o.id)::int AS cnt,
               BOOL_OR(${IN_STOCK}) AS in_stock, BOOL_AND(s."isSample") AS all_sample
        FROM "ProductOffer" o
        JOIN "ShoppingSource" s ON s.id = o."sourceId" AND s.status = 'ACTIVE'
        WHERE o."productId" = ${productId}::uuid AND o."observedAt" >= ${this.freshCutoff()}`;
        return {
          low: paiseFromDbOrNull(row?.low ?? null),
          count: row?.cnt ?? 0,
          inStock: row?.in_stock ?? false,
          sampleData: row?.all_sample ?? false,
        };
      },
    );
  }

  private productStatic(id: string) {
    return this.cached(this.cache.catalogKey("product", id), this.options.ttl.product, async () => {
      const p = await this.prisma.product.findFirst({
        where: { id, isActive: true },
        include: {
          category: { select: categorySelect },
          variants: { orderBy: { variantKey: "asc" } },
        },
      });
      if (!p) throw AppError.notFound("Product");
      return {
        ...productCore(p),
        description: p.description,
        manufacturer: p.manufacturer,
        gtin: p.gtin,
        ean: p.ean,
        upc: p.upc,
        specifications: (p.specifications ?? {}) as Record<string, unknown>,
        variants: p.variants.map(toVariantView),
      };
    });
  }

  async getProduct(id: string) {
    const [detail, summary] = await Promise.all([this.productStatic(id), this.offerSummary(id)]);
    return {
      ...detail,
      lowestPricePaise: summary.low,
      offerCount: summary.count,
      inStock: summary.inStock,
      sampleData: summary.sampleData,
    };
  }

  async getVariants(productId: string): Promise<VariantView[]> {
    return (await this.productStatic(productId)).variants;
  }

  async getOffers(
    productId: string,
    opts: { variantId?: string; includeStale?: boolean } = {},
  ): Promise<OfferView[]> {
    await this.productStatic(productId); // 404 for unknown/inactive products
    const key = this.cache.catalogKey(
      "offers",
      productId,
      opts.variantId ?? "all",
      opts.includeStale ? "stale" : "fresh",
    );
    const offers = await this.cached(key, this.options.ttl.offers, async () => {
      const rows = await this.prisma.productOffer.findMany({
        where: {
          productId,
          ...(opts.variantId ? { variantId: opts.variantId } : {}),
          ...(opts.includeStale ? {} : { observedAt: { gte: this.freshCutoff() } }),
          source: { status: "ACTIVE" },
        },
        include: { source: { select: { id: true, slug: true, name: true, isSample: true } } },
        orderBy: [{ sellingPricePaise: "asc" }, { id: "asc" }],
        take: 200,
      });
      return rows.map((o) => toOfferView(o, false));
    });
    // Staleness is evaluated at read time, never frozen into the cache.
    return offers.map((o) => ({ ...o, isStale: this.isStale(o.observedAt) }));
  }

  async getPriceHistory(
    productId: string,
    q: { days: number; variantId?: string; source?: string },
  ) {
    await this.productStatic(productId);
    const key = this.cache.catalogKey(
      "history",
      productId,
      q.variantId ?? "all",
      q.source ?? "all",
      q.days,
    );
    return this.cached(key, this.options.ttl.history, async () => {
      const to = this.now();
      const from = new Date(to.getTime() - q.days * 86_400_000);
      const snapshots = await this.prisma.priceSnapshot.findMany({
        where: {
          observedAt: { gte: from },
          offer: {
            productId,
            ...(q.variantId ? { variantId: q.variantId } : {}),
            source: { status: "ACTIVE", ...(q.source ? { slug: q.source } : {}) },
          },
        },
        include: {
          offer: { select: { id: true, variantId: true, source: { select: { slug: true } } } },
        },
        orderBy: { observedAt: "asc" },
        take: 5_000,
      });
      const prices = snapshots.map((s) => paiseFromDb(s.sellingPricePaise));
      return {
        productId,
        from: from.toISOString(),
        to: to.toISOString(),
        points: snapshots.map((s) => ({
          offerId: s.offer.id,
          variantId: s.offer.variantId,
          sourceSlug: s.offer.source.slug,
          mrpPaise: paiseFromDbOrNull(s.mrpPaise),
          sellingPricePaise: paiseFromDb(s.sellingPricePaise),
          shippingPaise: paiseFromDbOrNull(s.shippingPaise),
          stockStatus: s.stockStatus,
          observedAt: s.observedAt.toISOString(),
        })),
        lowestPricePaise: prices.length ? Math.min(...prices) : null,
        highestPricePaise: prices.length ? Math.max(...prices) : null,
      };
    });
  }

  // ── Shopping sources ────────────────────────────────────────────────────
  // Public status data only: configuration, health and metrics. Credentials
  // never live in the database, so nothing secret can be selected here.

  private readonly sourceSelect = {
    id: true,
    slug: true,
    name: true,
    domain: true,
    baseUrl: true,
    logoUrl: true,
    integrationKind: true,
    status: true,
    statusReason: true,
    isSample: true,
    health: true,
    lastHealthCheckAt: true,
    lastHealthError: true,
    lastSuccessAt: true,
  } as const;

  private sourceView(
    s: Prisma.ShoppingSourceGetPayload<{ select: CatalogService["sourceSelect"] }>,
  ) {
    const connectorStatus = effectiveStatus(s.status, s.health);
    return {
      ...s,
      connectorStatus,
      available: connectorStatus === "ACTIVE" || connectorStatus === "DEGRADED",
      lastHealthCheckAt: iso(s.lastHealthCheckAt),
      lastSuccessAt: iso(s.lastSuccessAt),
    };
  }

  /** Every registered source with its honest status (ACTIVE, PENDING_*, FAILED…). */
  async listSources() {
    const rows = await this.prisma.shoppingSource.findMany({
      orderBy: { name: "asc" },
      select: this.sourceSelect,
    });
    return rows.map((s) => this.sourceView(s));
  }

  /** Source detail by id or slug: status, tuning, capabilities and metrics. */
  async getSource(idOrSlug: string) {
    const s = await this.prisma.shoppingSource.findFirst({
      where: UUID_RE.test(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug },
      select: {
        ...this.sourceSelect,
        timeoutMs: true,
        rateLimitPerMinute: true,
        maxRetries: true,
        cacheTtlSeconds: true,
        circuitFailureThreshold: true,
        circuitOpenSeconds: true,
        capabilities: true,
      },
    });
    if (!s) throw AppError.notFound("Source");
    const {
      timeoutMs,
      rateLimitPerMinute,
      maxRetries,
      cacheTtlSeconds,
      circuitFailureThreshold,
      circuitOpenSeconds,
      capabilities,
      ...view
    } = s;
    const empty: SourceMetrics = {
      requests: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      rateLimitEvents: 0,
      cacheHits: 0,
      results: 0,
      latencyMsTotal: 0,
      averageLatencyMs: null,
      errorsByCategory: {},
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCategory: null,
    };
    const { latencyMsTotal: _total, ...metrics } = this.options.metrics
      ? await this.options.metrics.read(s.slug)
      : empty;
    return {
      ...this.sourceView(view),
      tuning: {
        timeoutMs,
        rateLimitPerMinute,
        maxRetries,
        cacheTtlSeconds,
        circuitFailureThreshold,
        circuitOpenSeconds,
      },
      capabilities: (capabilities ?? {}) as Record<string, unknown>,
      metrics,
    };
  }

  /** Integration summary of every registered source (no credentials or config). */
  async sourceStatus() {
    const rows = await this.listSources();
    return {
      totalSources: rows.length,
      activeSources: rows.filter((s) => s.available).length,
      healthySources: rows.filter((s) => s.available && s.health === "HEALTHY").length,
      sources: rows.map((s) => ({
        slug: s.slug,
        name: s.name,
        status: s.status,
        connectorStatus: s.connectorStatus,
        statusReason: s.statusReason,
        isSample: s.isSample,
        integrationKind: s.integrationKind,
        health: s.health,
        lastHealthCheckAt: s.lastHealthCheckAt,
      })),
    };
  }
}

function productCore(p: {
  id: string;
  name: string;
  brand: string;
  modelNumber: string | null;
  imageUrl: string | null;
  launchDate: Date | null;
  category: CategoryRow | null;
}): ProductCore {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    modelNumber: p.modelNumber,
    imageUrl: p.imageUrl,
    category: p.category ? toCategory(p.category) : null,
    launchDate: iso(p.launchDate),
  };
}

export function toVariantView(v: {
  id: string;
  variantKey: string;
  attributes: Prisma.JsonValue;
  sku: string | null;
  gtin: string | null;
}): VariantView {
  return {
    id: v.id,
    variantKey: v.variantKey,
    attributes: (v.attributes ?? {}) as Record<string, unknown>,
    sku: v.sku,
    gtin: v.gtin,
  };
}

export function toOfferView(
  o: Prisma.ProductOfferGetPayload<object> & {
    source: { id: string; slug: string; name: string; isSample: boolean };
  },
  isStale: boolean,
): OfferView {
  const selling = paiseFromDb(o.sellingPricePaise);
  const mrp = paiseFromDbOrNull(o.mrpPaise);
  return {
    id: o.id,
    productId: o.productId,
    variantId: o.variantId,
    source: o.source,
    title: o.title,
    productUrl: o.productUrl,
    sellerName: o.sellerName,
    mrpPaise: mrp,
    sellingPricePaise: selling,
    shippingPaise: paiseFromDbOrNull(o.shippingPaise),
    currency: "INR",
    discountBasisPoints: discountBasisPoints(selling, mrp),
    stockStatus: o.stockStatus,
    offerConditions: (o.offerConditions ?? {}) as Record<string, unknown>,
    observedAt: o.observedAt.toISOString(),
    sourceUpdatedAt: iso(o.sourceUpdatedAt),
    isStale,
    matchMethod: o.matchMethod,
    matchConfidence: o.matchConfidence,
  };
}
