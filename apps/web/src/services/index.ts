/**
 * Typed clients for the Fastify API (/api/v1, via the same-origin proxy).
 * Every function maps 1:1 to an endpoint; no response is ever fabricated.
 */
import type {
  AlertStatusValue,
  CreateSearchInput,
  NotificationCategoryValue,
  BillingIntervalValue,
} from "@dealmind/shared";
import { type RequestOptions, api, apiPage, queryString } from "@/lib/api";
/** History period: days, or every stored observation. */
export type HistoryDays = number | "all";

import type {
  AlertEvaluation,
  CreateAlertRequest,
  UpdateAlertRequest,
  CategoryDetail,
  CompareView,
  CategoryFiltersView,
  CategoryNode,
  Notification,
  Checkout,
  Invoice,
  Payment,
  NotificationPreferences,
  PushSubscribeRequest,
  UpdateNotificationPreferences,
  Plan,
  PriceAlert,
  PriceHistory,
  ProductDetail,
  ProductPricingView,
  ProductSummary,
  Search,
  SearchDetail,
  SearchResultSort,
  SearchResultView,
  SearchSourceRun,
  SourceStatus,
  Subscription,
  Usage,
  Variant,
  Watchlist,
  WatchlistDetail,
} from "@/types/api";

// ── Catalog (shared, public) ──────────────────────────────────────────────

export interface ProductQuery {
  q?: string;
  category?: string;
  brand?: string;
  minPricePaise?: number;
  maxPricePaise?: number;
  inStock?: boolean;
  launchedAfter?: string;
  spec?: string[];
  sort?: "relevance" | "newest" | "price_asc" | "price_desc" | "name";
  page?: number;
  pageSize?: number;
}

export const catalog = {
  categoryTree: () => api<CategoryNode[]>("GET", "/categories/tree"),
  category: (idOrSlug: string) =>
    api<CategoryDetail>("GET", `/categories/${encodeURIComponent(idOrSlug)}`),
  /** Filters derived from the category's stored catalog data. */
  categoryFilters: (slug: string, opts?: RequestOptions) =>
    api<CategoryFiltersView>(
      "GET",
      `/categories/${encodeURIComponent(slug)}/filters`,
      undefined,
      opts,
    ),
  products: (q: ProductQuery = {}, opts?: RequestOptions) =>
    apiPage<ProductSummary>(
      `/products${queryString({ ...q, inStock: q.inStock === undefined ? undefined : String(q.inStock) })}`,
      opts,
    ),
  product: (id: string) => api<ProductDetail>("GET", `/products/${id}`),
  variants: (id: string) => api<Variant[]>("GET", `/products/${id}/variants`),
  pricing: (id: string, variantId?: string, opts: { includeStale?: boolean } = {}) =>
    api<ProductPricingView>(
      "GET",
      `/products/${id}/pricing${queryString({ variantId, includeStale: opts.includeStale ? "true" : undefined })}`,
    ),
  /** Deterministic recommendations across 1–4 picked variants. */
  compare: (items: { productId: string; variantId: string }[]) =>
    api<CompareView>(
      "GET",
      `/compare${queryString({ items: items.map((i) => `${i.productId}:${i.variantId}`).join(",") })}`,
    ),
  history: (id: string, opts: { variantId?: string; days?: HistoryDays } = {}) =>
    api<PriceHistory>("GET", `/products/${id}/history${queryString(opts)}`),
  sourceStatus: () => api<SourceStatus>("GET", "/sources/status"),
};

// ── Search (user-owned) ───────────────────────────────────────────────────

export const searches = {
  create: (input: CreateSearchInput) => api<Search>("POST", "/search", input),
  list: (page = 1, pageSize = 20) => apiPage<Search>(`/search${queryString({ page, pageSize })}`),
  get: (id: string) => api<SearchDetail>("GET", `/search/${id}`),
  results: (
    id: string,
    q: { page?: number; pageSize?: number; sort?: SearchResultSort } = {},
    opts?: RequestOptions,
  ) =>
    apiPage<SearchResultView>(
      `/search/${id}/results${queryString({ page: q.page ?? 1, pageSize: q.pageSize ?? 20, sort: q.sort && q.sort !== "rank" ? q.sort : undefined })}`,
      opts,
    ),
  sources: (id: string) => api<SearchSourceRun[]>("GET", `/search/${id}/sources`),
  cancel: (id: string) => api<Search>("POST", `/search/${id}/cancel`),
  eventsUrl: (id: string) => `/api/v1/search/${id}/events`,
};

// ── Watchlists (user-owned) ───────────────────────────────────────────────

export const watchlists = {
  list: (opts: { variantId?: string } = {}) =>
    apiPage<Watchlist>(`/watchlists${queryString({ pageSize: 100, variantId: opts.variantId })}`),
  get: (id: string) => api<WatchlistDetail>("GET", `/watchlists/${id}`),
  create: (name: string) => api<Watchlist>("POST", "/watchlists", { name }),
  rename: (id: string, name: string) => api<Watchlist>("PATCH", `/watchlists/${id}`, { name }),
  remove: (id: string) => api<void>("DELETE", `/watchlists/${id}`),
  addItem: (id: string, variantId: string, note?: string) =>
    api<WatchlistDetail>("POST", `/watchlists/${id}/items`, {
      variantId,
      ...(note ? { note } : {}),
    }),
  removeItem: (id: string, itemId: string) =>
    api<void>("DELETE", `/watchlists/${id}/items/${itemId}`),
};

// ── Price alerts (user-owned) ─────────────────────────────────────────────

export const alerts = {
  list: (status?: AlertStatusValue, page = 1, variantId?: string) =>
    apiPage<PriceAlert>(`/alerts${queryString({ status, page, pageSize: 50, variantId })}`),
  create: (input: CreateAlertRequest) => api<PriceAlert>("POST", "/alerts", input),
  history: (id: string, opts: { page?: number; triggersOnly?: boolean } = {}) =>
    apiPage<AlertEvaluation>(
      `/alerts/${id}/history${queryString({ page: opts.page ?? 1, pageSize: 20, outcome: opts.triggersOnly ? "TRIGGERED" : undefined })}`,
    ),
  update: (id: string, input: UpdateAlertRequest) =>
    api<PriceAlert>("PATCH", `/alerts/${id}`, input),
  cancel: (id: string) => api<PriceAlert>("POST", `/alerts/${id}/cancel`),
  pause: (id: string) => api<PriceAlert>("POST", `/alerts/${id}/pause`),
  resume: (id: string) => api<PriceAlert>("POST", `/alerts/${id}/resume`),
  remove: (id: string) => api<void>("DELETE", `/alerts/${id}`),
};

// ── Notifications (user-owned) ────────────────────────────────────────────

export const notifications = {
  list: (opts: { unread?: boolean; page?: number; category?: NotificationCategoryValue } = {}) =>
    apiPage<Notification>(
      `/notifications${queryString({ page: opts.page ?? 1, pageSize: 20, unread: opts.unread === undefined ? undefined : String(opts.unread), category: opts.category })}`,
    ),
  unreadCount: () => api<{ unread: number }>("GET", "/notifications/unread-count"),
  markRead: (id: string) => api<Notification>("PATCH", `/notifications/${id}/read`, {}),
  markAllRead: () => api<{ updated: number }>("POST", "/notifications/read-all"),
  remove: (id: string) => api<void>("DELETE", `/notifications/${id}`),
  /** Same-origin SSE stream of the caller's notification changes. */
  streamUrl: "/api/v1/notifications/stream",
  preferences: () => api<NotificationPreferences>("GET", "/users/me/notification-preferences"),
  updatePreferences: (body: UpdateNotificationPreferences) =>
    api<NotificationPreferences>("PATCH", "/users/me/notification-preferences", body),
  /** One-click email unsubscribe (signed token from the email). */
  unsubscribe: (token: string) =>
    api<{ category: NotificationCategoryValue; channel: "email" }>(
      "POST",
      "/notifications/unsubscribe",
      { token },
    ),
};

export const push = {
  config: () => api<{ publicKey: string | null }>("GET", "/push/config"),
  subscribe: (body: PushSubscribeRequest) =>
    api<{ id: string; createdAt: string }>("POST", "/push/subscribe", body),
  unsubscribe: (endpoint: string) => api<void>("DELETE", "/push/subscribe", { endpoint }),
};

// ── Subscription (user-owned) ─────────────────────────────────────────────

export const billing = {
  plans: () => api<Plan[]>("GET", "/billing/plans"),
  subscription: () => api<Subscription>("GET", "/billing/subscription"),
  usage: () => api<Usage>("GET", "/usage"),
  startCheckout: (body: { plan: "PRO" | "BUSINESS"; interval: BillingIntervalValue }) =>
    api<Checkout>("POST", "/billing/checkout", body),
  checkout: (id: string) => api<Checkout>("GET", `/billing/checkout/${id}`),
  /** Forwards the payment proof for server-side verification (never trusted by itself). */
  confirmCheckout: (
    id: string,
    body:
      | { razorpayPaymentId: string; razorpaySubscriptionId: string; razorpaySignature: string }
      | { sandboxOutcome: "success" | "failure" },
  ) => api<Checkout>("POST", `/billing/checkout/${id}/confirm`, body),
  cancel: (reason?: string) =>
    api<Subscription>("POST", "/billing/cancel", reason ? { reason } : {}),
  changePlan: (body: { plan: "FREE" | "PRO" | "BUSINESS"; interval: BillingIntervalValue }) =>
    api<Subscription>("POST", "/billing/change-plan", body),
  payments: () => api<Payment[]>("GET", "/billing/payments"),
  invoices: () => api<Invoice[]>("GET", "/billing/invoices"),
  /** Same-origin CSV download (plan feature). */
  exportUrl: (kind: "watchlists" | "alerts" | "searches") => `/api/v1/exports/${kind}.csv`,
};
