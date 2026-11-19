/**
 * Public catalog routes (shared data; no account needed to browse).
 *   /categories, /products, /sources
 */
import {
  dealView,
  dealPolicyView,
  dealsQuery,
  paginationOf,
  AppError,
  ErrorCode,
  compareQuery,
  compareView,
  productPricingQuery,
  productPricingView,
  categoryDetail,
  categoryFilters,
  categoryNode,
  categoryView,
  offerQuery,
  offerView,
  priceHistory,
  priceHistoryQuery,
  productDetail,
  productListQuery,
  productSummary,
  sourceDetail,
  sourceStatus,
  sourceView,
  variantView,
} from "@dealmind/shared";
import { type PricingService, compareOffers, recommend } from "@dealmind/intelligence";
import type { EntitlementService } from "@dealmind/billing";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ok, page, paginated } from "../../utils/http.js";
import type { CatalogService } from "./catalog-service.js";

const idParam = z.object({ id: z.string().uuid() });

export const categoryRoutes: FastifyPluginAsyncZod<{ catalog: CatalogService }> = async (
  app,
  { catalog },
) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["catalog"],
        summary: "List all categories (flat)",
        response: { 200: ok(z.array(categoryView)) },
      },
    },
    async () => catalog.listCategories(),
  );

  app.get(
    "/tree",
    {
      schema: {
        tags: ["catalog"],
        summary: "Category hierarchy",
        response: { 200: ok(z.array(categoryNode)) },
      },
    },
    async () => catalog.categoryTree(),
  );

  app.get(
    "/:idOrSlug",
    {
      schema: {
        tags: ["catalog"],
        summary: "Category details with breadcrumb and children",
        params: z.object({ idOrSlug: z.string().trim().min(1).max(100) }),
        response: { 200: ok(categoryDetail) },
      },
    },
    async (req) => catalog.getCategory(req.params.idOrSlug),
  );

  app.get(
    "/:idOrSlug/filters",
    {
      schema: {
        tags: ["catalog"],
        summary: "Search filters for a category, derived from its stored catalog data",
        params: z.object({ idOrSlug: z.string().trim().min(1).max(100) }),
        response: { 200: ok(categoryFilters) },
      },
    },
    async (req) => catalog.categoryFilters(req.params.idOrSlug),
  );
};

export const productRoutes: FastifyPluginAsyncZod<{
  catalog: CatalogService;
  pricing: PricingService;
  entitlements: EntitlementService;
}> = async (app, { catalog, pricing, entitlements }) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["catalog"],
        summary: "List / search products (filters, sorting, pagination)",
        querystring: productListQuery,
        response: { 200: page(productSummary) },
      },
    },
    async (req) => catalog.listProducts(req.query),
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["catalog"],
        summary: "Product details with variants",
        params: idParam,
        response: { 200: ok(productDetail) },
      },
    },
    async (req) => catalog.getProduct(req.params.id),
  );

  app.get(
    "/:id/variants",
    {
      schema: {
        tags: ["catalog"],
        summary: "Product variants",
        params: idParam,
        response: { 200: ok(z.array(variantView)) },
      },
    },
    async (req) => catalog.getVariants(req.params.id),
  );

  app.get(
    "/:id/offers",
    {
      schema: {
        tags: ["catalog"],
        summary: "Offers from active sources, cheapest first (fresh only unless includeStale=true)",
        params: idParam,
        querystring: offerQuery,
        response: { 200: ok(z.array(offerView)) },
      },
    },
    async (req) => catalog.getOffers(req.params.id, req.query),
  );

  app.get(
    "/:id/pricing",
    {
      schema: {
        tags: ["catalog"],
        summary:
          "Fresh offers with deterministic pricing: delivered price, verified direct discount, " +
          "conditional benefits (with verification status), EMI costs and price-history claims",
        params: idParam,
        querystring: productPricingQuery,
        response: { 200: ok(productPricingView) },
      },
    },
    async (req) => {
      const offers = await catalog.getOffers(req.params.id, {
        ...(req.query.variantId ? { variantId: req.query.variantId } : {}),
        includeStale: req.query.includeStale,
      });
      // Anonymous pricing: no user eligibility is known, so no conditional benefit is applied.
      const candidates = await pricing.candidates(offers.map((o) => o.id));
      const byId = new Map(candidates.map((c) => [c.offerId, c.pricing]));
      // Stale offers may be listed (flagged) but never count as current: comparisons and
      // recommendations use fresh offers only.
      const fresh = new Set(offers.filter((o) => !o.isStale).map((o) => o.id));
      const current = candidates.filter((c) => fresh.has(c.offerId));
      const priced = offers
        .filter((o) => byId.has(o.id))
        .map((o) => ({ offer: o, pricing: byId.get(o.id)! }))
        .sort(
          (a, b) =>
            a.pricing.prices.deliveredPaise - b.pricing.prices.deliveredPaise ||
            a.offer.id.localeCompare(b.offer.id),
        );
      const cmp = compareOffers(current);
      return {
        productId: req.params.id,
        variantId: req.query.variantId ?? null,
        offers: priced,
        recommendations: recommend(current, { now: pricing.clock() }),
        comparison: {
          cheapestDelivered: cmp.cheapestDelivered,
          cheapestVerifiedPayable: cmp.cheapestVerifiedPayable,
          highestDirectDiscount: cmp.highestDirectDiscount,
          sameVariant: cmp.sameVariant,
          notes: cmp.notes,
        },
      };
    },
  );

  // "/history" is canonical; "/price-history" is kept as an alias for existing clients.
  for (const path of ["/:id/history", "/:id/price-history"]) {
    app.get(
      path,
      {
        schema: {
          tags: ["catalog"],
          summary: "Append-only price history from active sources (default 90 days)",
          params: idParam,
          querystring: priceHistoryQuery,
          response: { 200: ok(priceHistory) },
        },
      },
      async (req) => {
        // Plan limit on history depth (signed-out visitors get FREE's).
        const limit = await historyLimit(entitlements, await app.optionalAuth(req));
        const wanted = req.query.days;
        const clamp = limit > 0 && (wanted === "all" || wanted > limit);
        const history = await catalog.getPriceHistory(req.params.id, {
          ...req.query,
          days: clamp ? limit : wanted,
        });
        return { ...history, planLimitDays: clamp ? limit : null };
      },
    );
  }
};

async function historyLimit(
  entitlements: EntitlementService,
  auth: { userId: string } | null,
): Promise<number> {
  if (auth) return (await entitlements.context(auth.userId)).plan.limits.historyDays;
  return (await entitlements.plans()).get("FREE")!.limits.historyDays;
}

/** Public deals from already-stored offers (no marketplace is contacted). */
export const dealRoutes: FastifyPluginAsyncZod<{
  catalog: CatalogService;
  liveSearch: boolean;
}> = async (app, { catalog, liveSearch }) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["catalog"],
        summary:
          "Current verified deals from products already in the catalog (closed deals are hidden)",
        querystring: dealsQuery,
        response: { 200: page(dealView) },
      },
    },
    async (req) => {
      const { items, total } = await catalog.deals(req.query);
      return paginated(items, paginationOf(req.query, total));
    },
  );

  app.get(
    "/policy",
    {
      schema: {
        tags: ["catalog"],
        summary: "What counts as a deal (minimum discount off MRP) and whether live search is on",
        response: { 200: ok(dealPolicyView) },
      },
    },
    async () => ({ minDiscountPercent: catalog.dealMinDiscountBp / 100, liveSearch }),
  );
};

export const sourceRoutes: FastifyPluginAsyncZod<{ catalog: CatalogService }> = async (
  app,
  { catalog },
) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["sources"],
        summary: "Every shopping source with its connector status (no credentials)",
        response: { 200: ok(z.array(sourceView)) },
      },
    },
    async () => catalog.listSources(),
  );

  app.get(
    "/status",
    {
      schema: {
        tags: ["sources"],
        summary: "Integration status of all registered sources",
        response: { 200: ok(sourceStatus) },
      },
    },
    async () => catalog.sourceStatus(),
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["sources"],
        summary: "Source detail by id or slug: status, tuning, health and metrics",
        params: z.object({
          id: z.union([z.string().uuid(), z.string().regex(/^[a-z][a-z0-9_]{0,49}$/)]),
        }),
        response: { 200: ok(sourceDetail) },
      },
    },
    async (req) => catalog.getSource(req.params.id),
  );
};

/**
 * GET /compare?items=productId:variantId,… — deterministic recommendations
 * across 1–4 picked variants (public catalog data; no user data involved).
 */
export const compareRoutes: FastifyPluginAsyncZod<{
  catalog: CatalogService;
  pricing: PricingService;
  entitlements: EntitlementService;
}> = async (app, { catalog, pricing, entitlements }) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["catalog"],
        summary:
          "Best-deal recommendations across picked variants (lowest delivered, highest verified " +
          "direct discount, best value, best historical position); affiliate-neutral",
        querystring: compareQuery,
        response: { 200: ok(compareView) },
      },
    },
    async (req) => {
      const auth = await app.optionalAuth(req);
      const max = auth
        ? (await entitlements.context(auth.userId)).plan.limits.compareItems
        : (await entitlements.plans()).get("FREE")!.limits.compareItems;
      if (req.query.items.length > max)
        throw new AppError(
          ErrorCode.PLAN_UPGRADE_REQUIRED,
          `Your plan compares up to ${max} products at a time. Upgrade to compare more.`,
          { limit: "compareItems", allowed: max },
        );
      const items = await Promise.all(
        req.query.items.map(async (item) => {
          const variants = await catalog.getVariants(item.productId); // 404 for unknown products
          if (!variants.some((v) => v.id === item.variantId)) throw AppError.notFound("Variant");
          const offers = await catalog.getOffers(item.productId, { variantId: item.variantId });
          return { ...item, offerIds: offers.filter((o) => !o.isStale).map((o) => o.id) };
        }),
      );
      const candidates = await pricing.candidates(items.flatMap((i) => i.offerIds));
      const now = pricing.clock();
      return {
        items: items.map((i) => {
          const own = recommend(
            candidates.filter((c) => i.offerIds.includes(c.offerId)),
            { now },
          ).items.find((r) => r.kind === "lowest_delivered");
          return {
            productId: i.productId,
            variantId: i.variantId,
            offerCount: i.offerIds.length,
            cheapestOfferId: own?.offerId ?? null,
            cheapestDeliveredPaise: own?.deliveredPricePaise ?? null,
          };
        }),
        recommendations: recommend(candidates, { now }),
      };
    },
  );
};
