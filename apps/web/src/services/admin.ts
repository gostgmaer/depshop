/**
 * Platform admin API (ADMIN role enforced by the API on every call; the UI's
 * own checks are only for navigation).
 */
import type {
  AdminAuditEntry,
  AdminDashboardView,
  AdminJobsView,
  AdminSourceView,
  AdminUserDetail,
  AiModelConfigView,
  SearchAnalyticsView,
  SubscriptionAnalyticsView,
} from "@dealmind/shared";
import { api, apiPage, queryString } from "@/lib/api";

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
}
export interface AiModelsResponse {
  config: AiModelConfigView;
  usage: {
    month: string;
    runs: number;
    failedRuns: number;
    inputTokens: number;
    outputTokens: number;
    byModel: {
      provider: string;
      model: string;
      runs: number;
      inputTokens: number;
      outputTokens: number;
    }[];
    estimatedCostPaise: number | null;
    limitReached: boolean;
  };
}
export interface AdminProductRow {
  id: string;
  name: string;
  brand: string;
  isActive: boolean;
  category: string | null;
  variants: number;
  offers: number;
  updatedAt: string;
}
export interface AdminProductDetail {
  id: string;
  name: string;
  brand: string;
  isActive: boolean;
  category: { id: string; name: string } | null;
  variants: {
    id: string;
    variantKey: string;
    attributes: Record<string, unknown>;
    sku: string | null;
    gtin: string | null;
    mpn: string | null;
  }[];
  offers: {
    id: string;
    variantId: string;
    title: string;
    productUrl: string;
    sellingPricePaise: number;
    mrpPaise: number | null;
    stockStatus: string;
    observedAt: string;
    matchMethod: string;
    matchConfidence: number;
    trackingState: string;
    source: { slug: string; name: string; isSample: boolean };
  }[];
}
export interface AdminCategory {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  products: number;
}
export interface AffiliateAdminView {
  summary: {
    from: string;
    to: string;
    clicks: {
      total: number;
      blocked: number;
      signedIn: number;
      bySource: { slug: string; name: string; clicks: number }[];
      byCategory: { category: string; clicks: number }[];
      byProvider: Record<string, number>;
    };
    conversions: Record<
      "PENDING" | "APPROVED" | "REJECTED" | "REVERSED",
      { count: number; commissionPaise: number; orderAmountPaise: number }
    >;
    payouts: Record<"PENDING" | "PAID" | "FAILED", { count: number; amountPaise: number }>;
  };
  programs: {
    sourceId: string;
    slug: string;
    marketplace: string;
    linksActive: boolean;
    reporting: string;
    note: string;
    enabled: boolean;
  }[];
}
export interface SystemView {
  checks: Record<string, "ok" | "fail" | "not_configured">;
  queues: { name: string; counts: Record<string, number>; workers: number; paused: boolean }[];
  at: string;
}

const A = "/admin";
export const admin = {
  dashboard: () => api<AdminDashboardView>("GET", `${A}/dashboard`),
  users: (q?: string, cursor?: string) =>
    api<{ items: AdminUserRow[]; nextCursor: string | null }>(
      "GET",
      `${A}/users${queryString({ q, cursor, limit: 25 })}`,
    ),
  user: (id: string) => api<AdminUserDetail>("GET", `${A}/users/${id}`),
  userAction: (id: string, action: "suspend" | "reactivate" | "sessions/revoke", reason: string) =>
    api<AdminUserDetail>("POST", `${A}/users/${id}/${action}`, { reason }),
  sources: () => api<AdminSourceView[]>("GET", `${A}/sources`),
  updateSource: (id: string, body: Record<string, unknown>) =>
    api<AdminSourceView>("PATCH", `${A}/sources/${id}`, body),
  healthCheck: (reason: string) =>
    api<{ queued: boolean; jobId: string }>("POST", `${A}/sources/health-check`, { reason }),
  aiModels: () => api<AiModelsResponse>("GET", `${A}/ai-models`),
  saveAiModels: (body: Record<string, unknown>) =>
    api<AiModelsResponse>("PUT", `${A}/ai-models`, body),
  aiHealth: () =>
    api<{
      status: string;
      agent?: { status?: string; provider?: string; model?: string };
      error?: string;
    }>("POST", `${A}/ai-models/health`),
  analytics: (days: number) =>
    api<SearchAnalyticsView>("GET", `${A}/analytics${queryString({ days })}`),
  subscriptions: () => api<SubscriptionAnalyticsView>("GET", `${A}/subscriptions`),
  paidSubscriptions: (page: number, status?: string) =>
    apiPage<{
      userId: string;
      email: string;
      plan: string;
      effectivePlan: string;
      status: string;
      interval: string | null;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      lastSyncedAt: string | null;
    }>(`${A}/subscriptions/users${queryString({ page, pageSize: 20, status })}`),
  affiliates: (days: number) =>
    api<AffiliateAdminView>("GET", `${A}/affiliates${queryString({ days })}`),
  setAffiliate: (sourceId: string, affiliateEnabled: boolean) =>
    api<unknown>("PATCH", `${A}/affiliates/sources/${sourceId}`, { affiliateEnabled }),
  jobs: () => api<AdminJobsView>("GET", `${A}/jobs`),
  retryJob: (queue: string, id: string, reason: string) =>
    api<{ retried: boolean }>("POST", `${A}/jobs/${encodeURIComponent(id)}/retry`, {
      queue,
      reason,
    }),
  system: () => api<SystemView>("GET", `${A}/system`),
  products: (page: number, q?: string) =>
    apiPage<AdminProductRow>(`${A}/products${queryString({ page, pageSize: 20, q })}`),
  product: (id: string) => api<AdminProductDetail>("GET", `${A}/products/${id}`),
  updateProduct: (id: string, body: Record<string, unknown>) =>
    api<unknown>("PATCH", `${A}/products/${id}`, body),
  categories: () => api<AdminCategory[]>("GET", `${A}/categories`),
  updateCategory: (id: string, body: Record<string, unknown>) =>
    api<unknown>("PATCH", `${A}/categories/${id}`, body),
  audit: (page: number, action?: string) =>
    apiPage<AdminAuditEntry>(`${A}/audit-logs${queryString({ page, pageSize: 25, action })}`),
};
