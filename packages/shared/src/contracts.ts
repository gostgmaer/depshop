/**
 * Request/response contracts for the catalog and user-feature modules.
 * Money is always integer paise; timestamps are ISO-8601 strings.
 * Input schemas are `.strict()`: unknown keys (e.g. userId, status) are
 * rejected, which prevents mass assignment.
 */
import { z } from "zod";
import { pageQuery } from "./envelope.js";
import { pricingResultSchema } from "./pricing-contracts.js";
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

/**
 * Filters available in one category, derived from the catalog data actually
 * stored for it (never a hard-coded list per category). Each value is sent back
 * as a search spec filter exactly as given in `value`.
 */
export const categoryFilters = z.object({
  category: categoryView,
  /** Direct subcategories (narrow the search). */
  subcategories: z.array(categoryView.extend({ productCount: z.number().int() })),
  brands: z.array(z.object({ name: z.string(), count: z.number().int() })),
  /** Delivered price range of fresh offers in this category; null when none. */
  priceRange: z.object({ minPaise: paise, maxPaise: paise }).nullable(),
  specs: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      /** Products (not offers) that state this specification. */
      productCount: z.number().int(),
      values: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().int() })),
    }),
  ),
  /** Whether any product here has a known launch date (launch filter meaningful). */
  hasLaunchDates: z.boolean(),
  /** No verified rating data exists yet, so a rating filter is never offered. */
  ratingsAvailable: z.literal(false),
  productCount: z.number().int(),
});
export type CategoryFiltersView = z.infer<typeof categoryFilters>;

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

/**
 * An offer with its deterministic pricing (computed by the pricing engine from
 * the database): delivered price, verified direct discount, conditional
 * benefits with their verification status, EMI costs and history claims.
 */
export const offerPricingView = z.object({ offer: offerView, pricing: pricingResultSchema });
export type OfferPricingView = z.infer<typeof offerPricingView>;

export const productPricingQuery = z
  .object({
    variantId: uuid.optional(),
    /** Also list offers not observed recently (flagged isStale; never recommended or "lowest"). */
    includeStale: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .default("false"),
  })
  .strict();

export const recommendationView = z.object({
  kind: z.enum([
    "lowest_delivered",
    "highest_direct_discount",
    "best_value",
    "best_history_position",
  ]),
  offerId: uuid.nullable(),
  productId: uuid.nullable(),
  variantId: uuid.nullable(),
  marketplace: z.object({ slug: z.string(), name: z.string() }).nullable(),
  deliveredPricePaise: paise.nullable(),
  reasons: z.array(z.string()),
  unavailableReason: z.string().nullable(),
});
export const recommendationsView = z.object({
  items: z.array(recommendationView),
  considered: z.number().int(),
  excluded: z.array(z.object({ reason: z.string(), count: z.number().int() })),
  basis: z.string(),
});
export type RecommendationsView = z.infer<typeof recommendationsView>;

/** `items=productId:variantId,…` (1–4 picks) for GET /compare. */
export const compareQuery = z
  .object({
    items: z
      .string()
      .max(400)
      .transform((raw, ctx) => {
        const out: { productId: string; variantId: string }[] = [];
        for (const part of raw.split(",").filter(Boolean)) {
          const [productId, variantId, extra] = part.split(":");
          if (
            extra !== undefined ||
            !uuid.safeParse(productId).success ||
            !uuid.safeParse(variantId).success
          ) {
            ctx.addIssue({
              code: "custom",
              message: `Invalid item "${part}" (use productId:variantId)`,
            });
            return z.NEVER;
          }
          if (!out.some((o) => o.variantId === variantId))
            out.push({ productId: productId!, variantId: variantId! });
        }
        if (out.length < 1 || out.length > 4) {
          ctx.addIssue({ code: "custom", message: "Compare 1 to 4 items" });
          return z.NEVER;
        }
        return out;
      }),
  })
  .strict();

export const compareView = z.object({
  items: z.array(
    z.object({
      productId: uuid,
      variantId: uuid,
      /** Fresh offers of this variant that were considered. */
      offerCount: z.number().int(),
      /** Lowest eligible delivered offer of this item (null when none is available). */
      cheapestOfferId: uuid.nullable(),
      cheapestDeliveredPaise: paise.nullable(),
    }),
  ),
  recommendations: recommendationsView,
});
export type CompareView = z.infer<typeof compareView>;

export const productPricingView = z.object({
  productId: uuid,
  variantId: uuid.nullable(),
  /** Fresh offers from active sources, cheapest delivered first. */
  offers: z.array(offerPricingView),
  /** Deterministic best-deal picks among this variant's eligible offers. */
  recommendations: recommendationsView,
  comparison: z.object({
    cheapestDelivered: uuid.nullable(),
    cheapestVerifiedPayable: uuid.nullable(),
    highestDirectDiscount: uuid.nullable(),
    sameVariant: z.boolean(),
    notes: z.array(z.string()),
  }),
});
export type ProductPricingView = z.infer<typeof productPricingView>;

export const priceHistoryQuery = z
  .object({
    variantId: uuid.optional(),
    source: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(), // source slug
    /** 1–365 days, or "all" for every stored observation. */
    days: z.union([z.literal("all"), z.coerce.number().int().min(1).max(365)]).default(90),
  })
  .strict();
export type PriceHistoryQuery = z.infer<typeof priceHistoryQuery>;

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
  /** First stored observation for this product/variant/source scope (any period); null when none. */
  trackingSince: iso.nullable(),
  /** True when the period had more observations than returned (the newest are always kept). */
  truncated: z.boolean(),
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

export const SEARCH_SORT_MODES = [
  "best_value",
  "lowest_price",
  "highest_discount",
  "recently_launched",
  "price_drop",
  "trending_deals",
  "relevance",
] as const;
export type SearchSortMode = (typeof SEARCH_SORT_MODES)[number];

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
    /** Ranking mode chosen in the UI (wins over the one the AI infers). */
    sortMode: z.enum(SEARCH_SORT_MODES).optional(),
    /** Minimum verified direct discount (MRP-based, validated by the pricing engine), in percent. */
    minDiscountPercent: z.number().int().min(1).max(90).optional(),
    /** Only products whose launch date is known and within this many days. */
    launchedWithinDays: z
      .union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)])
      .optional(),
    /** Exclude offers whose availability isn't confirmed (pre-order, unknown). */
    inStockOnly: z.boolean().optional(),
    /** Required specifications chosen in the UI, as name/value text (canonicalized server-side). */
    specs: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(40),
            value: z.string().trim().min(1).max(60),
          })
          .strict(),
      )
      .max(10)
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

/** Ranking modes a user can choose (trending needs popularity data DealMind doesn't collect). */
export const USER_RANKING_MODES = [
  "best_value",
  "highest_discount",
  "lowest_price",
  "recently_launched",
  "price_drop",
] as const satisfies readonly SearchSortMode[];

/** Re-ordering of a finished result list (the stored ranking is never rewritten). */
export const searchResultSort = z.enum(["rank", "price_asc", "discount_desc", "newest"]);
export type SearchResultSort = z.infer<typeof searchResultSort>;
export const searchResultsQuery = pageQuery
  .extend({ sort: searchResultSort.default("rank") })
  .strict();
export type SearchResultsQuery = z.infer<typeof searchResultsQuery>;

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
  /** Ranking mode actually used, and whether the user chose it or the AI inferred it. */
  ranking: z.object({ mode: z.string(), chosenBy: z.enum(["user", "ai"]) }).nullable(),
});

export const searchResultView = z.object({
  rank: z.number().int(),
  score: z.number().int(),
  explanation: z.string().nullable(),
  /** Price/MRP captured when the search ran. */
  pricePaiseAtSearch: paise,
  mrpPaiseAtSearch: paise.nullable(),
  offer: offerView,
  product: productRef.extend({ modelNumber: z.string().nullable(), launchDate: iso.nullable() }),
  /** Variant attributes of the offer (canonical keys from the catalog). */
  variantAttributes: z.record(z.unknown()),
  /** Current pricing of the offer (null if it can no longer be priced). */
  pricing: pricingResultSchema.nullable(),
});
export type SearchResultView = z.infer<typeof searchResultView>;

/** Progress events of the search SSE stream (GET /search/:id/events). */
export const searchEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("node_started"), node: z.string(), at: z.string() }),
  z.object({ type: z.literal("node_finished"), node: z.string(), at: z.string() }),
  z.object({ type: z.literal("status"), status: z.string(), at: z.string() }),
  z.object({
    type: z.literal("sources_planned"),
    sources: z.array(z.string()),
    skipped: z.array(z.string()),
    at: z.string(),
  }),
  z.object({
    type: z.literal("source_finished"),
    source: z.string(),
    status: z.enum(["SUCCEEDED", "FAILED", "TIMED_OUT", "SKIPPED"]),
    resultCount: z.number().int(),
    at: z.string(),
  }),
]);
export type SearchEvent = z.infer<typeof searchEvent>;

// ── Watchlists (user-owned) ───────────────────────────────────────────────

export const watchlistName = z.string().trim().min(1).max(80);
export const createWatchlistInput = z.object({ name: watchlistName }).strict();
export const renameWatchlistInput = z.object({ name: watchlistName }).strict();
/** `variantId`: only your watchlists that contain this variant. */
export const watchlistListQuery = pageQuery.extend({ variantId: uuid.optional() }).strict();
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
  /** Lowest delivered price among fresh, available offers (same as current.deliveredPaise). */
  lowestPricePaise: paise.nullable(),
  current: z
    .object({
      deliveredPaise: paise,
      marketplace: z.object({ slug: z.string(), name: z.string() }),
      observedAt: iso,
      /** Fresh, available offers of this variant. */
      offerCount: z.number().int(),
    })
    .nullable(),
  /**
   * Movement of the lowest delivered price over the last 7 days, from stored
   * snapshots. Null when there was no observation 7 days ago (never estimated).
   */
  movement: z
    .object({
      days: z.literal(7),
      previousPaise: paise,
      changePaise: z.number().int(),
      changeBp: z.number().int(),
    })
    .nullable(),
});

export const watchlistDetail = watchlistView.extend({ items: z.array(watchlistItemView) });

// ── Price alerts (user-owned) ─────────────────────────────────────────────

export const ALERT_STATUSES = ["ACTIVE", "PAUSED", "TRIGGERED", "EXPIRED", "CANCELLED"] as const;
export const alertStatus = z.enum(ALERT_STATUSES);
export type AlertStatusValue = z.infer<typeof alertStatus>;

/** User actions on an alert and the statuses each is allowed from. */
export const ALERT_ACTIONS = {
  /** Change the condition, channels, cooldown, expiry or marketplace. */
  update: ["ACTIVE", "PAUSED", "TRIGGERED"],
  pause: ["ACTIVE"],
  /** Resume a paused alert, or re-arm a triggered one. */
  resume: ["PAUSED", "TRIGGERED"],
  cancel: ["ACTIVE", "PAUSED", "TRIGGERED"],
  /** Delete is allowed from any status (removes the alert and its history). */
  delete: ["ACTIVE", "PAUSED", "TRIGGERED", "EXPIRED", "CANCELLED"],
} as const satisfies Record<string, readonly AlertStatusValue[]>;
export type AlertAction = keyof typeof ALERT_ACTIONS;

export function canTransition(action: AlertAction, from: AlertStatusValue): boolean {
  return (ALERT_ACTIONS[action] as readonly string[]).includes(from);
}

export const DELIVERY_CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;
export const deliveryChannel = z.enum(DELIVERY_CHANNELS);

export const ALERT_TYPES = [
  "TARGET_PRICE",
  "PRICE_BELOW",
  "PERCENT_DROP",
  "HISTORICAL_LOW",
  "PRICE_CHANGE",
  "BACK_IN_STOCK",
  "PRICE_DROP",
] as const;
export const alertType = z.enum(ALERT_TYPES);
export type AlertTypeValue = z.infer<typeof alertType>;

/** Which parameter each alert type requires (the others must be absent). */
export const ALERT_TYPE_PARAM: Record<
  AlertTypeValue,
  "target" | "drop" | "window" | "minChange" | null
> = {
  TARGET_PRICE: "target",
  PRICE_BELOW: "target",
  PERCENT_DROP: "drop",
  HISTORICAL_LOW: "window",
  // Optional minimum change for these two.
  PRICE_CHANGE: "minChange",
  PRICE_DROP: "minChange",
  BACK_IN_STOCK: null,
};

const futureIso = z
  .string()
  .datetime({ offset: true })
  .refine((v) => Date.parse(v) > Date.now(), "Must be in the future")
  .refine((v) => Date.parse(v) <= Date.now() + 366 * 86_400_000, "At most one year ahead");

const alertParams = {
  targetPricePaise: z.number().int().positive(),
  /** Whole percent (1–90) for PERCENT_DROP. */
  dropPercent: z.number().int().min(1).max(90),
  historicalWindowDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
  /** Minimum minutes between two notifications of this alert (default 24 h). */
  cooldownMinutes: z.number().int().min(0).max(43_200),
  /** PRICE_CHANGE / PRICE_DROP: minimum absolute change in paise (optional). */
  minChangePaise: z.number().int().positive(),
  /** Channels this alert may use (the user's preferences still apply). */
  channels: z
    .array(deliveryChannel)
    .min(1)
    .max(3)
    .refine((c) => new Set(c).size === c.length, "Each channel at most once"),
  /** Keep watching after the condition is met (default: stop and mark TRIGGERED). */
  repeat: z.boolean(),
  expiresAt: futureIso,
};

function checkAlertParams(
  v: {
    type: AlertTypeValue;
    targetPricePaise?: number | undefined;
    dropPercent?: number | undefined;
    historicalWindowDays?: number | undefined;
    minChangePaise?: number | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (v.minChangePaise !== undefined && ALERT_TYPE_PARAM[v.type] !== "minChange")
    ctx.addIssue({ code: "custom", path: ["minChangePaise"], message: `Not used by ${v.type}` });
  const want = ALERT_TYPE_PARAM[v.type];
  const given = {
    target: v.targetPricePaise !== undefined,
    drop: v.dropPercent !== undefined,
    window: v.historicalWindowDays !== undefined,
  };
  for (const [k, present] of Object.entries(given)) {
    const field =
      k === "target" ? "targetPricePaise" : k === "drop" ? "dropPercent" : "historicalWindowDays";
    if (want === "minChange") {
      if (present)
        ctx.addIssue({ code: "custom", path: [field], message: `Not used by ${v.type}` });
      continue;
    }
    if (k === want && !present && k !== "window")
      ctx.addIssue({ code: "custom", path: [field], message: `Required for ${v.type}` });
    if (k !== want && present)
      ctx.addIssue({ code: "custom", path: [field], message: `Not used by ${v.type}` });
  }
}

export const createAlertInput = z
  .object({
    variantId: uuid,
    /** Defaults to TARGET_PRICE (earlier clients send only targetPricePaise). */
    type: alertType.default("TARGET_PRICE"),
    targetPricePaise: alertParams.targetPricePaise.optional(),
    dropPercent: alertParams.dropPercent.optional(),
    /** HISTORICAL_LOW window; defaults to 90 days. */
    historicalWindowDays: alertParams.historicalWindowDays.optional(),
    cooldownMinutes: alertParams.cooldownMinutes.optional(),
    minChangePaise: alertParams.minChangePaise.optional(),
    channels: alertParams.channels.optional(),
    repeat: alertParams.repeat.optional(),
    expiresAt: alertParams.expiresAt.optional(),
    /** Restrict to one source (the preferred marketplace); omit for "any active source". */
    sourceId: uuid.optional(),
  })
  .strict()
  .superRefine(checkAlertParams);
export type CreateAlertInput = z.infer<typeof createAlertInput>;

export const updateAlertInput = z
  .object({
    targetPricePaise: alertParams.targetPricePaise.optional(),
    dropPercent: alertParams.dropPercent.optional(),
    historicalWindowDays: alertParams.historicalWindowDays.optional(),
    cooldownMinutes: alertParams.cooldownMinutes.optional(),
    minChangePaise: alertParams.minChangePaise.nullable().optional(),
    channels: alertParams.channels.optional(),
    repeat: alertParams.repeat.optional(),
    expiresAt: alertParams.expiresAt.nullable().optional(),
    sourceId: uuid.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field" });

export const alertHistoryQuery = pageQuery
  .extend({
    /** Only these outcomes, e.g. TRIGGERED for previous triggers. */
    outcome: z
      .enum(["TRIGGERED", "NOT_MET", "COOLDOWN", "SUPPRESSED", "INSUFFICIENT_DATA"])
      .optional(),
  })
  .strict();
export type UpdateAlertInput = z.infer<typeof updateAlertInput>;

export const alertEvaluationView = z.object({
  id: uuid,
  outcome: z.enum(["TRIGGERED", "NOT_MET", "COOLDOWN", "SUPPRESSED", "INSUFFICIENT_DATA"]),
  observedPricePaise: paise.nullable(),
  marketplace: z.object({ slug: z.string(), name: z.string() }),
  reason: z.string(),
  notificationId: uuid.nullable(),
  evaluatedAt: iso,
});
export type AlertEvaluationView = z.infer<typeof alertEvaluationView>;

export const alertListQuery = pageQuery
  .extend({ status: alertStatus.optional(), variantId: uuid.optional() })
  .strict();

export const alertView = z.object({
  id: uuid,
  status: alertStatus,
  type: alertType,
  /** TARGET_PRICE / PRICE_BELOW only. */
  targetPricePaise: paise.nullable(),
  dropPercentBp: z.number().int().nullable(),
  /** PERCENT_DROP reference price (null until recorded). */
  baselinePricePaise: paise.nullable(),
  historicalWindowDays: z.number().int().nullable(),
  cooldownMinutes: z.number().int(),
  lastEvaluatedAt: iso.nullable(),
  minChangePaise: paise.nullable(),
  repeat: z.boolean(),
  expiresAt: iso.nullable(),
  channels: z.array(deliveryChannel),
  triggerCount: z.number().int(),
  cancelledAt: iso.nullable(),
  /** Current lowest delivered price of a fresh, available offer (on the alert's marketplace if set). */
  current: z
    .object({
      deliveredPaise: paise,
      marketplace: z.object({ slug: z.string(), name: z.string() }),
      observedAt: iso,
    })
    .nullable(),
  /**
   * Target alerts: how far the price has moved from where it was when the
   * alert started toward the target (0–10000 bp). Null without a start price
   * or current price.
   */
  progressBp: z.number().int().min(0).max(10_000).nullable(),
  source: sourceRef.nullable(),
  variant: variantView,
  product: productRef,
  lastTriggeredAt: iso.nullable(),
  lastTriggeredPricePaise: paise.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

// ── Notifications (user-owned) ────────────────────────────────────────────

// Moved to notification-contracts.ts (Phase 5.3).

// ── Subscriptions & usage (user-owned) ────────────────────────────────────

// Plan, subscription and usage views moved to billing-contracts.ts (Phase 6.1).
