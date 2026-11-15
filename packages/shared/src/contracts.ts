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

export const stockStatus = z.enum(["IN_STOCK", "LIMITED", "OUT_OF_STOCK", "PREORDER", "UNKNOWN"]);
export type StockStatusValue = z.infer<typeof stockStatus>;
export const matchMethod = z.enum([
  "IDENTIFIER",
  "MPN",
  "MODEL_NUMBER",
  "NORMALIZED_TITLE",
  "FUZZY_TITLE",
  "SEMANTIC",
  "MANUAL",
  "NEW_PRODUCT",
]);
export const sourceStatusValue = z.enum([
  "ACTIVE",
  "PENDING_CREDENTIALS",
  "PENDING_APPROVAL",
  "DISABLED",
  "MAINTENANCE",
]);
/** Admin status combined with runtime health (what users and admins see). */
export const connectorStatusValue = z.enum([
  "ACTIVE",
  "PENDING_CREDENTIALS",
  "PENDING_APPROVAL",
  "DISABLED",
  "DEGRADED",
  "FAILED",
]);

export const categoryView = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
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
  /** Active products in this category and all of its descendants. */
  productCount: z.number().int(),
});

export const productSort = z.enum(["relevance", "newest", "price_asc", "price_desc", "name"]);

/** Specification filter keys (variant attributes / product specifications). */
const specKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Invalid specification key");
const specValue = z.string().trim().min(1).max(60);

/**
 * `spec=ram_gb:8&spec=storage_gb:256&spec=color_family:black`. Numeric values
 * match numerically; text values case-insensitively (normalized lower-case).
 */
export const specFilters = z
  .union([z.string(), z.array(z.string()).max(10)])
  .transform((v, ctx) => {
    const out: Record<string, string | number> = {};
    for (const raw of Array.isArray(v) ? v : [v]) {
      const i = raw.indexOf(":");
      const key = specKey.safeParse(raw.slice(0, i));
      const value = specValue.safeParse(raw.slice(i + 1));
      if (i < 1 || !key.success || !value.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid spec filter "${raw}" (use key:value)`,
        });
        return z.NEVER;
      }
      const text = value.data.toLowerCase();
      out[key.data] = /^\d+(\.\d+)?$/.test(text) ? Number(text) : text;
    }
    return out;
  });

export const productListQuery = pageQuery
  .extend({
    q: z.string().trim().min(2).max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(), // slug (includes descendants)
    brand: z.string().trim().min(1).max(100).optional(),
    minPricePaise: z.coerce.number().int().nonnegative().optional(),
    maxPricePaise: z.coerce.number().int().nonnegative().optional(),
    launchedAfter: z.coerce.date().optional(),
    launchedBefore: z.coerce.date().optional(),
    /** Only products with a fresh in-stock (or limited) offer from an active source. */
    inStock: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    spec: specFilters.optional(),
    sort: productSort.default("relevance"),
  })
  .strict()
  .refine(
    (v) => v.minPricePaise == null || v.maxPricePaise == null || v.minPricePaise <= v.maxPricePaise,
    {
      message: "minPricePaise must be <= maxPricePaise",
      path: ["minPricePaise"],
    },
  )
  .refine((v) => !v.launchedAfter || !v.launchedBefore || v.launchedAfter <= v.launchedBefore, {
    message: "launchedAfter must be <= launchedBefore",
    path: ["launchedAfter"],
  });
export type ProductListQuery = z.infer<typeof productListQuery>;

export const productSummary = z.object({
  id: uuid,
  name: z.string(),
  brand: z.string(),
  modelNumber: z.string().nullable(),
  imageUrl: z.string().nullable(),
  category: categoryView.nullable(),
  launchDate: iso.nullable(),
  /** Lowest price among fresh offers from active sources; null when none. */
  lowestPricePaise: paise.nullable(),
  /** Fresh offers from active sources. */
  offerCount: z.number().int(),
  inStock: z.boolean(),
  /** True when every counted offer comes from development sample data. */
  sampleData: z.boolean(),
});
export type ProductSummary = z.infer<typeof productSummary>;

export const variantView = z.object({
  id: uuid,
  variantKey: z.string(),
  attributes: z.record(z.unknown()),
  sku: z.string().nullable(),
  gtin: z.string().nullable(),
});
export type VariantView = z.infer<typeof variantView>;

export const productDetail = productSummary.extend({
  description: z.string().nullable(),
  manufacturer: z.string().nullable(),
  gtin: z.string().nullable(),
  ean: z.string().nullable(),
  upc: z.string().nullable(),
  specifications: z.record(z.unknown()),
  variants: z.array(variantView),
});

/** Minimal product reference embedded in user-owned views. */
export const productRef = z.object({
  id: uuid,
  name: z.string(),
  brand: z.string(),
  imageUrl: z.string().nullable(),
});

export const sourceRef = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  /** Development sample data (fictional store): never a real offer. */
  isSample: z.boolean(),
});

export const offerQuery = z
  .object({
    variantId: uuid.optional(),
    /** Include offers not observed recently (flagged `isStale`). Default false. */
    includeStale: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .default("false"),
  })
  .strict();

export const offerView = z.object({
  id: uuid,
  productId: uuid,
  variantId: uuid,
  source: sourceRef,
  /** Marketplace title, verbatim. */
  title: z.string(),
  productUrl: z.string(),
  sellerName: z.string().nullable(),
  mrpPaise: paise.nullable(),
  sellingPricePaise: paise,
  shippingPaise: paise.nullable(),
  currency: z.literal("INR"),
  /** Deterministic discount vs MRP in basis points (0 when no genuine discount). */
  discountBasisPoints: z.number().int(),
  stockStatus,
  offerConditions: z.record(z.unknown()),
  observedAt: iso,
  sourceUpdatedAt: iso.nullable(),
  /** Not observed within the freshness window: shown as last-known, never as live. */
  isStale: z.boolean(),
  matchMethod,
  matchConfidence: z.number().int(),
});
export type OfferView = z.infer<typeof offerView>;

export const priceHistoryQuery = z
  .object({
    variantId: uuid.optional(),
    source: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(), // source slug
    days: z.coerce.number().int().min(1).max(365).default(90),
  })
  .strict();

export const pricePoint = z.object({
  offerId: uuid,
  variantId: uuid,
  sourceSlug: z.string(),
  mrpPaise: paise.nullable(),
  sellingPricePaise: paise,
  shippingPaise: paise.nullable(),
  stockStatus,
  observedAt: iso,
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
  slug: z.string(),
  name: z.string(),
  domain: z.string(),
  baseUrl: z.string(),
  logoUrl: z.string().nullable(),
  integrationKind: z.string(),
  status: sourceStatusValue,
  /** ACTIVE / DEGRADED / FAILED / PENDING_CREDENTIALS / PENDING_APPROVAL / DISABLED. */
  connectorStatus: connectorStatusValue,
  /** Why the source has this status (e.g. which approval is pending). */
  statusReason: z.string().nullable(),
  /** Mock/sample source with fictional data — never a real marketplace. */
  isSample: z.boolean(),
  /** Participates in live search (ACTIVE or DEGRADED). */
  available: z.boolean(),
  health: z.enum(["UNKNOWN", "HEALTHY", "DEGRADED", "DOWN"]),
  lastHealthCheckAt: iso.nullable(),
  lastHealthError: z.string().nullable(),
  lastSuccessAt: iso.nullable(),
});

export const sourceMetricsView = z.object({
  requests: z.number().int(),
  successes: z.number().int(),
  failures: z.number().int(),
  timeouts: z.number().int(),
  rateLimitEvents: z.number().int(),
  cacheHits: z.number().int(),
  results: z.number().int(),
  averageLatencyMs: z.number().int().nullable(),
  errorsByCategory: z.record(z.number().int()),
  lastSuccessAt: iso.nullable(),
  lastFailureAt: iso.nullable(),
  lastErrorCategory: z.string().nullable(),
});

/** Source detail: configuration (never credentials) and execution metrics. */
export const sourceDetail = sourceView.extend({
  tuning: z.object({
    timeoutMs: z.number().int(),
    rateLimitPerMinute: z.number().int(),
    maxRetries: z.number().int(),
    cacheTtlSeconds: z.number().int(),
    circuitFailureThreshold: z.number().int(),
    circuitOpenSeconds: z.number().int(),
  }),
  capabilities: z.record(z.unknown()),
  metrics: sourceMetricsView,
});

export const sourceStatus = z.object({
  totalSources: z.number().int(),
  activeSources: z.number().int(),
  healthySources: z.number().int(),
  sources: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      status: sourceStatusValue,
      connectorStatus: connectorStatusValue,
      statusReason: z.string().nullable(),
      isSample: z.boolean(),
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
    sourceSlugs: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
      .max(20)
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.minPricePaise == null || v.maxPricePaise == null || v.minPricePaise <= v.maxPricePaise,
    {
      message: "minPricePaise must be <= maxPricePaise",
      path: ["minPricePaise"],
    },
  );

export const createSearchInput = z
  .object({
    query: z.string().trim().min(2, "Describe what you are looking for").max(500),
    filters: searchFilters.optional(),
  })
  .strict();
export type CreateSearchInput = z.infer<typeof createSearchInput>;

export const searchStatus = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "NEEDS_CLARIFICATION",
  "CANCELLED",
]);
export type SearchStatusValue = z.infer<typeof searchStatus>;
export const TERMINAL_SEARCH_STATUSES: readonly SearchStatusValue[] = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "NEEDS_CLARIFICATION",
  "CANCELLED",
];

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

export const agentRunSummary = z.object({
  id: uuid,
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]),
  provider: z.string(),
  model: z.string(),
  durationMs: z.number().int().nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  startedAt: iso,
  finishedAt: iso.nullable(),
});

export const searchDetail = searchView.extend({
  sourceRuns: z.array(searchSourceRunView),
  /** The AI's validated interpretation of the query (filters it derived). */
  interpretation: z.record(z.unknown()).nullable(),
  /** Set when the agent needs more information instead of guessing. */
  clarificationQuestion: z.string().nullable(),
  /** Explanation generated from verified results only. */
  summary: z.string().nullable(),
  warnings: z.array(z.string()),
  agentRun: agentRunSummary.nullable(),
});

export const searchResultView = z.object({
  rank: z.number().int(),
  score: z.number().int(),
  explanation: z.string().nullable(),
  /** Price/MRP captured when the search ran. */
  pricePaiseAtSearch: paise,
  mrpPaiseAtSearch: paise.nullable(),
  offer: offerView,
  product: productRef,
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
  product: productRef,
  lowestPricePaise: paise.nullable(),
});

export const watchlistDetail = watchlistView.extend({ items: z.array(watchlistItemView) });

// ── Price alerts (user-owned) ─────────────────────────────────────────────

export const alertStatus = z.enum(["ACTIVE", "TRIGGERED", "PAUSED"]);

export const createAlertInput = z
  .object({
    variantId: uuid,
    targetPricePaise: z.number().int().positive(),
    /** Restrict to one source; omit for "any active source". */
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
  product: productRef,
  lastTriggeredAt: iso.nullable(),
  lastTriggeredPricePaise: paise.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

// ── Notifications (user-owned) ────────────────────────────────────────────

export const notificationListQuery = pageQuery
  .extend({
    unread: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  })
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
