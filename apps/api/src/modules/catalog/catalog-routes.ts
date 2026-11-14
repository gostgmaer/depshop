/**
 * Public catalog routes (shared data; no account needed to browse).
 *   /categories, /products, /sources
 */
import {
  categoryDetail,
  categoryNode,
  categoryView,
  offerView,
  priceHistory,
  priceHistoryQuery,
  productDetail,
  productListQuery,
  productSummary,
  sourceStatus,
  sourceView,
  variantView,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ok, page } from "../../utils/http.js";
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
};

export const productRoutes: FastifyPluginAsyncZod<{ catalog: CatalogService }> = async (
  app,
  { catalog },
) => {
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
        summary: "Marketplace offers from enabled sources, cheapest first",
        params: idParam,
        querystring: z.object({ variantId: z.string().uuid().optional() }).strict(),
        response: { 200: ok(z.array(offerView)) },
      },
    },
    async (req) => catalog.getOffers(req.params.id, req.query.variantId),
  );

  app.get(
    "/:id/price-history",
    {
      schema: {
        tags: ["catalog"],
        summary: "Price snapshots over time (default 90 days)",
        params: idParam,
        querystring: priceHistoryQuery,
        response: { 200: ok(priceHistory) },
      },
    },
    async (req) => catalog.getPriceHistory(req.params.id, req.query.days, req.query.variantId),
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
        summary: "Enabled shopping sources",
        response: { 200: ok(z.array(sourceView)) },
      },
    },
    async () => catalog.listEnabledSources(),
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
    "/:code",
    {
      schema: {
        tags: ["sources"],
        summary: "Source availability",
        params: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/) }),
        response: { 200: ok(sourceView) },
      },
    },
    async (req) => catalog.getSource(req.params.code),
  );
};
