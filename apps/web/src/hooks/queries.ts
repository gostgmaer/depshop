"use client";

/**
 * TanStack Query hooks over the typed services. Query keys are hierarchical
 * so mutations invalidate exactly what they change.
 */
import {
  type AlertStatusValue,
  type NotificationCategoryValue,
  type CreateSearchInput,
  TERMINAL_SEARCH_STATUSES,
} from "@dealmind/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SearchResultSort, UpdateNotificationPreferences } from "@/types/api";
import {
  type HistoryDays,
  type ProductQuery,
  alerts,
  billing,
  catalog,
  notifications,
  searches,
  watchlists,
} from "@/services";

export const keys = {
  categories: ["categories"] as const,
  products: (q: ProductQuery) => ["products", q] as const,
  product: (id: string) => ["product", id] as const,
  pricing: (id: string, variantId?: string, includeStale = false) =>
    ["product", id, "pricing", variantId ?? "all", includeStale ? "stale" : "fresh"] as const,
  compare: (items: string) => ["compare", items] as const,
  history: (id: string, variantId?: string, days: HistoryDays = 90) =>
    ["product", id, "history", variantId ?? "all", days] as const,
  sourceStatus: ["sources", "status"] as const,
  searches: (page: number) => ["searches", page] as const,
  search: (id: string) => ["search", id] as const,
  searchResults: (id: string) => ["search", id, "results"] as const,
  searchResultsPage: (id: string, page: number, sort: SearchResultSort) =>
    ["search", id, "results", page, sort] as const,
  categoryFilters: (slug: string) => ["categories", slug, "filters"] as const,
  suggestions: (q: string) => ["products", "suggest", q] as const,
  watchlists: ["watchlists"] as const,
  watchlist: (id: string) => ["watchlists", id] as const,
  alerts: (status?: string) => ["alerts", status ?? "all"] as const,
  variantAlerts: (variantId: string) => ["alerts", "variant", variantId] as const,
  variantWatchlists: (variantId: string) => ["watchlists", "variant", variantId] as const,
  notifications: (unread?: boolean, page = 1, category?: string) =>
    ["notifications", "list", unread ?? "all", category ?? "any", page] as const,
  notificationPreferences: ["notification-preferences"] as const,
  unread: ["notifications", "unread"] as const,
  plans: ["billing", "plans"] as const,
  launchOffer: ["billing", "offer"] as const,
  subscription: ["billing", "subscription"] as const,
  usage: ["billing", "usage"] as const,
};

// ── Catalog ──
export const useCategories = () =>
  useQuery({ queryKey: keys.categories, queryFn: catalog.categoryTree, staleTime: 10 * 60_000 });
export const useProducts = (q: ProductQuery, enabled = true) =>
  useQuery({
    queryKey: keys.products(q),
    queryFn: () => catalog.products(q),
    placeholderData: keepPreviousData,
    enabled,
  });
export const useProduct = (id: string) =>
  useQuery({ queryKey: keys.product(id), queryFn: () => catalog.product(id) });
/** Prices are short-lived: refetched every minute while the page is open. */
export const useProductPricing = (id: string, variantId?: string, includeStale = false) =>
  useQuery({
    queryKey: keys.pricing(id, variantId, includeStale),
    queryFn: () => catalog.pricing(id, variantId, { includeStale }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
export const usePriceHistory = (id: string, variantId?: string, days: HistoryDays = 90) =>
  useQuery({
    queryKey: keys.history(id, variantId, days),
    queryFn: () => catalog.history(id, { ...(variantId ? { variantId } : {}), days }),
    placeholderData: keepPreviousData,
  });
/** Recommendations across picked variants (catalog data; shareable, cached briefly). */
export const useCompare = (items: { productId: string; variantId: string }[]) =>
  useQuery({
    queryKey: keys.compare(items.map((i) => `${i.productId}:${i.variantId}`).join(",")),
    queryFn: () => catalog.compare(items),
    enabled: items.length > 0,
    staleTime: 30_000,
  });
/** Your alerts and watchlists for one variant (tracking history; owner-scoped by the API). */
export const useVariantTracking = (variantId: string | undefined) => {
  const alertsQ = useQuery({
    queryKey: keys.variantAlerts(variantId ?? ""),
    queryFn: () => alerts.list(undefined, 1, variantId),
    enabled: Boolean(variantId),
  });
  const listsQ = useQuery({
    queryKey: keys.variantWatchlists(variantId ?? ""),
    queryFn: () => watchlists.list({ variantId }),
    enabled: Boolean(variantId),
  });
  return { alerts: alertsQ, watchlists: listsQ };
};
/** Category filters change only when the catalog does: cached for 5 minutes. */
export const useCategoryFilters = (slug: string | undefined) =>
  useQuery({
    queryKey: keys.categoryFilters(slug ?? ""),
    queryFn: ({ signal }) => catalog.categoryFilters(slug!, { signal }),
    enabled: Boolean(slug),
    staleTime: 5 * 60_000,
  });
/** Catalog products matching typed text (the caller debounces; stale requests are aborted). */
export const useProductSuggestions = (q: string) =>
  useQuery({
    queryKey: keys.suggestions(q),
    queryFn: ({ signal }) => catalog.products({ q, pageSize: 5 }, { signal }),
    enabled: q.trim().length >= 3,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
export const useSourceStatus = () =>
  useQuery({ queryKey: keys.sourceStatus, queryFn: catalog.sourceStatus, staleTime: 60_000 });

// ── Search ──
export const useSearches = (page = 1) =>
  useQuery({ queryKey: keys.searches(page), queryFn: () => searches.list(page) });

const isTerminal = (status?: string) =>
  status !== undefined && (TERMINAL_SEARCH_STATUSES as readonly string[]).includes(status);

/** Polls while the search runs (SSE drives faster updates; polling is the fallback). */
export const useSearch = (id: string) =>
  useQuery({
    queryKey: keys.search(id),
    queryFn: () => searches.get(id),
    refetchInterval: (q) => (isTerminal(q.state.data?.status) ? false : 3_000),
  });
export const useSearchResults = (
  id: string,
  status?: string,
  page = 1,
  sort: SearchResultSort = "rank",
) =>
  useQuery({
    queryKey: keys.searchResultsPage(id, page, sort),
    queryFn: ({ signal }) => searches.results(id, { page, sort }, { signal }),
    enabled: status !== undefined && status !== "PENDING",
    refetchInterval: isTerminal(status) ? false : 4_000,
    placeholderData: keepPreviousData,
  });

export function useCreateSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSearchInput) => searches.create(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["searches"] });
      void qc.invalidateQueries({ queryKey: keys.usage });
    },
  });
}
export function useCancelSearch(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => searches.cancel(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.search(id) }),
  });
}

// ── Watchlists ──
export const useWatchlists = () =>
  useQuery({ queryKey: keys.watchlists, queryFn: () => watchlists.list() });
export const useWatchlist = (id: string) =>
  useQuery({
    queryKey: keys.watchlist(id),
    queryFn: () => watchlists.get(id),
    enabled: Boolean(id),
  });

export function useWatchlistMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: keys.watchlists });
  return {
    create: useMutation({ mutationFn: (name: string) => watchlists.create(name), onSuccess: done }),
    rename: useMutation({
      mutationFn: (v: { id: string; name: string }) => watchlists.rename(v.id, v.name),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => watchlists.remove(id), onSuccess: done }),
    addItem: useMutation({
      mutationFn: (v: { watchlistId: string; variantId: string; note?: string }) =>
        watchlists.addItem(v.watchlistId, v.variantId, v.note),
      onSuccess: done,
    }),
    removeItem: useMutation({
      mutationFn: (v: { watchlistId: string; itemId: string }) =>
        watchlists.removeItem(v.watchlistId, v.itemId),
      onSuccess: done,
    }),
  };
}

// ── Alerts ──
export const useAlerts = (status?: AlertStatusValue) =>
  useQuery({ queryKey: keys.alerts(status), queryFn: () => alerts.list(status) });

export function useAlertMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["alerts"] });
    void qc.invalidateQueries({ queryKey: keys.usage });
  };
  return {
    create: useMutation({
      mutationFn: (input: Parameters<typeof alerts.create>[0]) => alerts.create(input),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; body: Parameters<typeof alerts.update>[1] }) =>
        alerts.update(v.id, v.body),
      onSuccess: done,
    }),
    cancel: useMutation({ mutationFn: (id: string) => alerts.cancel(id), onSuccess: done }),
    pause: useMutation({ mutationFn: (id: string) => alerts.pause(id), onSuccess: done }),
    resume: useMutation({ mutationFn: (id: string) => alerts.resume(id), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => alerts.remove(id), onSuccess: done }),
  };
}

/** One alert's evaluation history (loaded when opened); triggersOnly = previous triggers. */
export const useAlertEvaluations = (id: string, enabled: boolean, triggersOnly = false) =>
  useQuery({
    queryKey: ["alerts", id, "history", triggersOnly] as const,
    queryFn: () => alerts.history(id, { triggersOnly }),
    enabled,
  });

// ── Notifications ──
export const useNotifications = (
  unread?: boolean,
  page = 1,
  category?: NotificationCategoryValue,
) =>
  useQuery({
    queryKey: keys.notifications(unread, page, category),
    queryFn: () =>
      notifications.list({
        ...(unread === undefined ? {} : { unread }),
        ...(category ? { category } : {}),
        page,
      }),
  });
export const useNotificationPreferences = () =>
  useQuery({ queryKey: keys.notificationPreferences, queryFn: notifications.preferences });
export function useUpdateNotificationPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateNotificationPreferences) => notifications.updatePreferences(body),
    onSuccess: (data) => qc.setQueryData(keys.notificationPreferences, data),
  });
}
export const useUnreadCount = () =>
  useQuery({ queryKey: keys.unread, queryFn: notifications.unreadCount, refetchInterval: 60_000 });
export function useNotificationMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ["notifications"] });
  return {
    markRead: useMutation({
      mutationFn: (id: string) => notifications.markRead(id),
      onSuccess: done,
    }),
    markAllRead: useMutation({ mutationFn: () => notifications.markAllRead(), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => notifications.remove(id), onSuccess: done }),
  };
}

// ── Billing ──
export const usePlans = () =>
  useQuery({ queryKey: keys.plans, queryFn: billing.plans, staleTime: 10 * 60_000 });
/** Free launch offer (null when billing is normal). */
export const useLaunchOffer = () =>
  useQuery({ queryKey: keys.launchOffer, queryFn: billing.offer, staleTime: 10 * 60_000 });
export const useSubscription = () =>
  useQuery({ queryKey: keys.subscription, queryFn: billing.subscription });
export const useUsage = () => useQuery({ queryKey: keys.usage, queryFn: () => billing.usage() });
export const usePayments = () =>
  useQuery({ queryKey: ["billing", "payments"] as const, queryFn: () => billing.payments() });
export const useInvoices = () =>
  useQuery({ queryKey: ["billing", "invoices"] as const, queryFn: () => billing.invoices() });
export function useBillingMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["billing"] });
    void qc.invalidateQueries({ queryKey: keys.usage });
  };
  return {
    cancel: useMutation({
      mutationFn: (reason?: string) => billing.cancel(reason),
      onSuccess: done,
    }),
    changePlan: useMutation({
      mutationFn: (v: Parameters<typeof billing.changePlan>[0]) => billing.changePlan(v),
      onSuccess: done,
    }),
    refresh: done,
  };
}
