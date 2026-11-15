/**
 * Typed clients for the Fastify API (/api/v1, via the same-origin proxy).
 * Every function maps 1:1 to an endpoint; no response is ever fabricated.
 */
import type { CreateSearchInput } from "@dealmind/shared";
import { api, apiPage, queryString } from "@/lib/api";
import type {
  CategoryDetail,
  CategoryNode,
  Notification,
  Plan,
  PriceAlert,
  PriceHistory,
  ProductDetail,
  ProductPricingView,
  ProductSummary,
  Search,
  SearchDetail,
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
  products: (q: ProductQuery = {}) =>
    apiPage<ProductSummary>(
      `/products${queryString({ ...q, inStock: q.inStock === undefined ? undefined : String(q.inStock) })}`,
    ),
  product: (id: string) => api<ProductDetail>("GET", `/products/${id}`),
  variants: (id: string) => api<Variant[]>("GET", `/products/${id}/variants`),
  pricing: (id: string, variantId?: string) =>
    api<ProductPricingView>("GET", `/products/${id}/pricing${queryString({ variantId })}`),
  history: (id: string, opts: { variantId?: string; days?: number } = {}) =>
    api<PriceHistory>("GET", `/products/${id}/history${queryString(opts)}`),
  sourceStatus: () => api<SourceStatus>("GET", "/sources/status"),
};

// ── Search (user-owned) ───────────────────────────────────────────────────

export const searches = {
  create: (input: CreateSearchInput) => api<Search>("POST", "/search", input),
  list: (page = 1, pageSize = 20) => apiPage<Search>(`/search${queryString({ page, pageSize })}`),
  get: (id: string) => api<SearchDetail>("GET", `/search/${id}`),
  results: (id: string, page = 1, pageSize = 50) =>
    apiPage<SearchResultView>(`/search/${id}/results${queryString({ page, pageSize })}`),
  sources: (id: string) => api<SearchSourceRun[]>("GET", `/search/${id}/sources`),
  cancel: (id: string) => api<Search>("POST", `/search/${id}/cancel`),
  eventsUrl: (id: string) => `/api/v1/search/${id}/events`,
};

// ── Watchlists (user-owned) ───────────────────────────────────────────────

export const watchlists = {
  list: () => apiPage<Watchlist>(`/watchlists${queryString({ pageSize: 100 })}`),
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
  list: (status?: "ACTIVE" | "TRIGGERED" | "PAUSED", page = 1) =>
    apiPage<PriceAlert>(`/alerts${queryString({ status, page, pageSize: 50 })}`),
  create: (input: { variantId: string; targetPricePaise: number; sourceId?: string }) =>
    api<PriceAlert>("POST", "/alerts", input),
  update: (id: string, input: { targetPricePaise?: number; sourceId?: string | null }) =>
    api<PriceAlert>("PATCH", `/alerts/${id}`, input),
  pause: (id: string) => api<PriceAlert>("POST", `/alerts/${id}/pause`),
  resume: (id: string) => api<PriceAlert>("POST", `/alerts/${id}/resume`),
  remove: (id: string) => api<void>("DELETE", `/alerts/${id}`),
};

// ── Notifications (user-owned) ────────────────────────────────────────────

export const notifications = {
  list: (opts: { unread?: boolean; page?: number } = {}) =>
    apiPage<Notification>(
      `/notifications${queryString({ page: opts.page ?? 1, pageSize: 20, unread: opts.unread === undefined ? undefined : String(opts.unread) })}`,
    ),
  unreadCount: () => api<{ unread: number }>("GET", "/notifications/unread-count"),
  markRead: (id: string) => api<Notification>("POST", `/notifications/${id}/read`),
  markAllRead: () => api<{ updated: number }>("POST", "/notifications/read-all"),
};

// ── Subscription (user-owned) ─────────────────────────────────────────────

export const billing = {
  plans: () => api<Plan[]>("GET", "/subscriptions/plans"),
  subscription: () => api<Subscription>("GET", "/subscriptions/me"),
  usage: () => api<Usage>("GET", "/subscriptions/me/usage"),
};
