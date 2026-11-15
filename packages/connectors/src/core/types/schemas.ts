/**
 * Connector boundary contracts. Every connector response is validated with
 * these schemas before anything else sees it. Money is integer paise.
 */
import { z } from "zod";

const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), "Only http(s) URLs are allowed");
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);

// ── Request ───────────────────────────────────────────────────────────────

export const shoppingSearchRequestSchema = z
  .object({
    /** Free-text query as the user typed it (trimmed). */
    query: z.string().trim().min(2).max(500),
    /** Category slug from the DealMind catalog (all categories supported). */
    category: z.string().trim().min(1).max(100).optional(),
    brands: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    minPricePaise: paise.optional(),
    maxPricePaise: paise.optional(),
    /** Maximum items wanted from each source. */
    limit: z.number().int().min(1).max(50).default(20),
    locale: z.literal("en-IN").default("en-IN"),
  })
  .strict();
export type ShoppingSearchRequest = z.input<typeof shoppingSearchRequestSchema>;
export type ValidSearchRequest = z.output<typeof shoppingSearchRequestSchema>;

// ── Capabilities ──────────────────────────────────────────────────────────

export const connectorCapabilitiesSchema = z.object({
  search: z.boolean(),
  productLookup: z.boolean(),
  /** Catalog category slugs, or "all". */
  categories: z.union([z.literal("all"), z.array(z.string()).min(1)]),
  price: z.boolean(),
  mrp: z.boolean(),
  stock: z.boolean(),
  shipping: z.boolean(),
  promotions: z.boolean(),
  maxResultsPerRequest: z.number().int().min(1),
});
export type ConnectorCapabilities = z.infer<typeof connectorCapabilitiesSchema>;

// ── Offers / promotions ───────────────────────────────────────────────────

/**
 * Conditional benefits (coupon, bank offer, cashback, exchange, membership).
 * They are NEVER subtracted from the selling price: whether a user qualifies
 * depends on their card, membership, device… so they are stored separately.
 */
export const promotionSchema = z
  .object({
    type: z.enum(["COUPON", "BANK_OFFER", "CASHBACK", "EXCHANGE", "MEMBERSHIP", "OTHER"]),
    description: z.string().trim().min(1).max(500),
    /** Flat amount when the source states one. */
    amountPaise: paise.optional(),
    /** Percentage in basis points when the source states one. */
    percentBasisPoints: z.number().int().min(0).max(10_000).optional(),
    /** Cap on the benefit, when stated. */
    maxAmountPaise: paise.optional(),
    code: z.string().trim().max(50).optional(),
    terms: z.string().trim().max(1000).optional(),
  })
  .strict();
export type Promotion = z.infer<typeof promotionSchema>;

/**
 * How trustworthy the price is:
 *  - LISTED: the source's listing price at observation time (not a checkout quote);
 *  - VERIFIED_CHECKOUT: confirmed by a checkout/cart quote API;
 *  - INDICATIVE: from discovery/search snippets — never shown as a checkout price.
 */
export const priceTypeSchema = z.enum(["LISTED", "VERIFIED_CHECKOUT", "INDICATIVE"]);

export const provenanceSchema = z
  .object({
    method: z.enum(["OFFICIAL_API", "AFFILIATE_FEED", "PARTNER", "DISCOVERY", "MOCK"]),
    /** Connector/provider that produced the data, e.g. "flipkart-affiliate-1.0". */
    provider: z.string().min(1).max(100),
    /** Upstream operation, e.g. "GET /affiliate/1.0/search.json" (no secrets, no query values). */
    operation: z.string().max(200).optional(),
    retrievedAt: z.coerce.date(),
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;

// ── Normalized product/offer ──────────────────────────────────────────────

export const normalizedProductSchema = z
  .object({
    sourceId: slug,
    externalId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(3).max(500),
    brand: z.string().trim().min(1).max(100),
    productUrl: httpUrl,
    imageUrl: httpUrl.optional(),
    categoryPath: z.array(z.string().max(100)).max(10).optional(),
    modelNumber: z.string().trim().min(1).max(100).optional(),
    /** Manufacturer part number (one configuration), only when the source publishes it. */
    mpn: z.string().trim().min(2).max(100).optional(),
    barcode: z.string().trim().max(20).optional(),
    sellingPricePaise: paise,
    mrpPaise: paise.optional(),
    shippingPaise: paise.optional(),
    priceType: priceTypeSchema,
    currency: z.literal("INR"),
    sellerName: z.string().trim().max(200).optional(),
    stockStatus: z.enum(["IN_STOCK", "LIMITED", "OUT_OF_STOCK", "PREORDER", "UNKNOWN"]),
    /** Product-level attributes as published (specs). */
    attributes: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
    /** Variant-level attributes (colour, size, storage…), as published. */
    variant: z
      .object({
        attributes: z.record(z.union([z.string().max(100), z.number()])).default({}),
        sku: z.string().trim().max(100).optional(),
      })
      .strict()
      .default({}),
    promotions: z.array(promotionSchema).max(50).default([]),
    sourceUpdatedAt: z.coerce.date().optional(),
    observedAt: z.coerce.date(),
    provenance: provenanceSchema,
  })
  .strict()
  .refine((p) => p.priceType !== "INDICATIVE" || p.provenance.method === "DISCOVERY", {
    message: "INDICATIVE prices may only come from discovery providers",
    path: ["priceType"],
  });
export type NormalizedProduct = z.output<typeof normalizedProductSchema>;
export type NormalizedProductInput = z.input<typeof normalizedProductSchema>;

export const connectorSearchResultSchema = z
  .object({
    sourceId: slug,
    items: z.array(z.unknown()).max(200),
    /** Total matches upstream, if the source reports it. */
    totalAvailable: z.number().int().nonnegative().optional(),
    fetchedAt: z.coerce.date(),
  })
  .strict();
export type ConnectorSearchResultInput = z.input<typeof connectorSearchResultSchema>;

/** A validated result: invalid items are dropped and counted, never passed on. */
export interface ConnectorSearchResult {
  sourceId: string;
  items: NormalizedProduct[];
  totalAvailable?: number;
  fetchedAt: Date;
  rejectedItems: number;
}

// ── Health ────────────────────────────────────────────────────────────────

export const connectorHealthSchema = z
  .object({
    status: z.enum(["HEALTHY", "DEGRADED", "DOWN", "UNKNOWN"]),
    checkedAt: z.coerce.date(),
    latencyMs: z.number().int().nonnegative().optional(),
    /** Human-readable reason; never contains credentials. */
    message: z.string().max(500).optional(),
  })
  .strict();
export type ConnectorHealth = z.output<typeof connectorHealthSchema>;

/**
 * Whether the connector itself can run: READY, or what it is waiting for.
 * Combined with the admin status (ShoppingSource.status) and runtime health.
 */
export type ConnectorReadiness =
  | { state: "READY" }
  | { state: "PENDING_CREDENTIALS"; missing: string[] }
  | { state: "PENDING_APPROVAL"; reason: string }
  | { state: "NOT_SUPPORTED"; reason: string };
