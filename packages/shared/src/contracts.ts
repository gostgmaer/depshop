/**
 * Request/response contracts for the catalog and user-feature modules.
 * Money is always integer paise; timestamps are ISO-8601 strings.
 * Input schemas are `.strict()`: unknown keys (e.g. userId, status) are
 * rejected, which prevents mass assignment.
 */
import { z } from "zod";
import { pageQuery } from "./envelope.js";
import { PlanCode } from "./schemas.js";

const uuid = z.string().uuid();
const paise = z.number().int().nonnegative();
const iso = z.string();

// ── Catalog (global, shared by every user) ────────────────────────────────

export const categoryView = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  parentId: uuid.nullable(),
});
export type CategoryView = z.infer<typeof categoryView>;

export type CategoryNode = CategoryView & { children: CategoryNode[] };
export const categoryNode: z.ZodType<CategoryNode> = categoryView.extend({
  children: z.lazy(() => z.array(categoryNode)),
});

export const categoryDetail = categoryView.extend({
  /** Root-first path, ending with this category. */
  breadcrumb: z.array(categoryView),
  children: z.array(categoryView),
  productCount: z.number().int(),
});

export const productSort = z.enum(["relevance", "newest", "price_asc", "price_desc", "title"]);

export const productListQuery = pageQuery
  .extend({
    q: z.string().trim().min(2).max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(), // slug
    brand: z.string().trim().min(1).max(100).optional(),
    minPricePaise: z.coerce.number().int().nonnegative().optional(),
    maxPricePaise: z.coerce.number().int().nonnegative().optional(),
    launchedAfter: z.coerce.date().optional(),
    sort: productSort.default("relevance"),
  })
  .strict()
  .refine((v) => v.minPricePaise == null || v.maxPricePaise == null || v.minPricePaise <= v.maxPricePaise, {
    message: "minPricePaise must be <= maxPricePaise",
    path: ["minPricePaise"],
  });
export type ProductListQuery = z.infer<typeof productListQuery>;

export const productSummary = z.object({
  id: uuid,
  title: z.string(),
  brand: z.string(),
  model: z.string().nullable(),
  imageUrl: z.string().nullable(),
  category: categoryView.nullable(),
  launchedAt: iso.nullable(),
  /** Lowest current price across offers from enabled sources, if any. */
  lowestPricePaise: paise.nullable(),
  offerCount: z.number().int(),
});
export type ProductSummary = z.infer<typeof productSummary>;

export const variantView = z.object({
  id: uuid,
  variantKey: z.string(),
  attributes: z.record(z.unknown()),
  gtin: z.string().nullable(),
});

export const productDetail = productSummary.extend({
  specs: z.record(z.unknown()),
  variants: z.array(variantView),
});

export const sourceRef = z.object({ id: uuid, code: z.string(), name: z.string() });

export const offerView = z.object({
  id: uuid,
  variantId: uuid,
  source: sourceRef,
  title: z.string(),
  url: z.string(),
  sellerName: z.string().nullable(),
  pricePaise: paise,
  mrpPaise: paise.nullable(),
  /** Deterministic discount vs MRP in basis points (0 when no genuine discount). */
  discountBasisPoints: z.number().int(),
  availability: z.string(),
  lastSeenAt: iso,
});
export type OfferView = z.infer<typeof offerView>;

export const priceHistoryQuery = z
  .object({
    variantId: uuid.optional(),
    days: z.coerce.number().int().min(1).max(365).default(90),
  })
  .strict();

export const pricePoint = z.object({
  offerId: uuid,
  sourceCode: z.string(),
  pricePaise: paise,
  mrpPaise: paise.nullable(),
  availability: z.string(),
  capturedAt: iso,
});

export const priceHistory = z.object({
  productId: uuid,
  from: iso,
  to: iso,
  points: z.array(pricePoint),
  lowestPricePaise: paise.nullable(),
  highestPricePaise: paise.nullable(),
});

// ── Shopping sources ──────────────────────────────────────────────────────

export const sourceView = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  integrationKind: z.string(),
  enabled: z.boolean(),
  /** Enabled and not known to be down. */
  available: z.boolean(),
  health: z.enum(["UNKNOWN", "HEALTHY", "DEGRADED", "DOWN"]),
  lastHealthCheckAt: iso.nullable(),
});

export const sourceStatus = z.object({
  totalSources: z.number().int(),
  enabledSources: z.number().int(),
  healthySources: z.number().int(),
  sources: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      integrationKind: z.string(),
      health: z.string(),
      lastHealthCheckAt: iso.nullable(),
    }),
  ),
});

// ── Search (user-owned) ───────────────────────────────────────────────────

export const searchFilters = z
  .object({
    minPricePaise: paise.optional(),
    maxPricePaise: paise.optional(),
    brands: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    sourceCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(20).optional(),
  })
  .strict()
  .refine((v) => v.minPricePaise == null || v.maxPricePaise == null || v.minPricePaise <= v.maxPricePaise, {
    message: "minPricePaise must be <= maxPricePaise",
    path: ["minPricePaise"],
  });

export const createSearchInput = z
  .object({
    query: z.string().trim().min(2, "Describe what you are looking for").max(500),
    filters: searchFilters.optional(),
  })
  .strict();
export type CreateSearchInput = z.infer<typeof createSearchInput>;

export const searchStatus = z.enum(["PENDING", "RUNNING", "COMPLETED", "PARTIAL", "FAILED"]);

export const searchSourceRunView = z.object({
  source: sourceRef,
  status: z.enum(["SUCCEEDED", "FAILED", "TIMED_OUT", "SKIPPED"]),
  resultCount: z.number().int(),
  durationMs: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const searchView = z.object({
  id: uuid,
  query: z.string(),
  filters: z.record(z.unknown()),
  status: searchStatus,
  resultCount: z.number().int(),
  createdAt: iso,
  completedAt: iso.nullable(),
});

export const searchDetail = searchView.extend({ sourceRuns: z.array(searchSourceRunView) });

export const searchResultView = z.object({
  rank: z.number().int(),
  score: z.number().int(),
  explanation: z.string().nullable(),
  /** Price/MRP captured when the search ran. */
  pricePaiseAtSearch: paise,
  mrpPaiseAtSearch: paise.nullable(),
  offer: offerView,
  product: z.object({ id: uuid, title: z.string(), brand: z.string(), imageUrl: z.string().nullable() }),
});

// ── Watchlists (user-owned) ───────────────────────────────────────────────

export const watchlistName = z.string().trim().min(1).max(80);
export const createWatchlistInput = z.object({ name: watchlistName }).strict();
export const renameWatchlistInput = z.object({ name: watchlistName }).strict();
export const addWatchlistItemInput = z
  .object({ variantId: uuid, note: z.string().trim().max(500).optional() })
  .strict();

export const watchlistView = z.object({
  id: uuid,
  name: z.string(),
  itemCount: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

export const watchlistItemView = z.object({
  id: uuid,
  note: z.string().nullable(),
  addedAt: iso,
  variant: variantView,
  product: z.object({ id: uuid, title: z.string(), brand: z.string(), imageUrl: z.string().nullable() }),
  lowestPricePaise: paise.nullable(),
});

export const watchlistDetail = watchlistView.extend({ items: z.array(watchlistItemView) });

// ── Price alerts (user-owned) ─────────────────────────────────────────────

export const alertStatus = z.enum(["ACTIVE", "TRIGGERED", "PAUSED"]);

export const createAlertInput = z
  .object({
    variantId: uuid,
    targetPricePaise: z.number().int().positive(),
    /** Restrict to one source; omit for "any enabled source". */
    sourceId: uuid.optional(),
  })
  .strict();

export const updateAlertInput = z
  .object({
    targetPricePaise: z.number().int().positive().optional(),
    sourceId: uuid.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field" });

export const alertListQuery = pageQuery.extend({ status: alertStatus.optional() }).strict();

export const alertView = z.object({
  id: uuid,
  status: alertStatus,
  targetPricePaise: paise,
  source: sourceRef.nullable(),
  variant: variantView,
  product: z.object({ id: uuid, title: z.string(), brand: z.string() }),
  lastTriggeredAt: iso.nullable(),
  lastTriggeredPricePaise: paise.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

// ── Notifications (user-owned) ────────────────────────────────────────────

export const notificationListQuery = pageQuery
  .extend({ unread: z.enum(["true", "false"]).transform((v) => v === "true").optional() })
  .strict();

export const notificationView = z.object({
  id: uuid,
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.unknown()),
  readAt: iso.nullable(),
  createdAt: iso,
});

// ── Subscriptions & usage (user-owned) ────────────────────────────────────

export const planView = z.object({
  code: PlanCode,
  name: z.string(),
  monthlyPricePaise: paise,
  limits: z.object({
    searchesPerDay: z.number().int(),
    activeAlerts: z.number().int(),
    watchlists: z.number().int(),
  }),
});
export type PlanView = z.infer<typeof planView>;

export const subscriptionView = z.object({
  plan: planView,
  status: z.enum(["ACTIVE", "PAST_DUE", "CANCELED"]),
  currentPeriodStart: iso,
  currentPeriodEnd: iso.nullable(),
  cancelAtPeriodEnd: z.boolean(),
});

const usageCounter = z.object({ used: z.number().int(), limit: z.number().int() });
export const usageView = z.object({
  plan: PlanCode,
  searchesToday: usageCounter.extend({ resetsAt: iso }),
  activeAlerts: usageCounter,
  watchlists: usageCounter,
});
