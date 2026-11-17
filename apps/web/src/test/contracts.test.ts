/** The test fixtures must satisfy the real API contracts (so UI tests can't drift from the API). */
import {
  priceHistory as priceHistorySchema,
  productDetail as productDetailSchema,
  categoryFilters as categoryFiltersSchema,
  productPricingView,
  searchDetail as searchDetailSchema,
  searchResultView,
} from "@dealmind/shared";
import { describe, expect, it } from "vitest";
import {
  priceHistory,
  productDetail,
  categoryFilters,
  productPricing,
  searchDetail,
  searchResult,
  searchResultVariant,
} from "./fixtures";

describe("fixtures match the shared Zod contracts", () => {
  it("search result, product pricing and search detail", () => {
    expect(searchResultView.safeParse(searchResult()).success).toBe(true);
    expect(productPricingView.safeParse(productPricing()).success).toBe(true);
    expect(searchDetailSchema.safeParse(searchDetail()).success).toBe(true);
    expect(
      searchResultView.safeParse(searchResultVariant(2, 2, { ram_gb: 12 }, 2_999_900)).success,
    ).toBe(true);
    expect(categoryFiltersSchema.safeParse(categoryFilters()).success).toBe(true);
    expect(productPricingView.safeParse(productPricing({ stale: true })).success).toBe(true);
    expect(priceHistorySchema.safeParse(priceHistory()).success).toBe(true);
    expect(productDetailSchema.safeParse(productDetail()).success).toBe(true);
    expect(categoryFiltersSchema.safeParse(categoryFilters("washing-machines")).success).toBe(true);
  });
});

describe("admin fixtures match the shared admin contracts", () => {
  it("dashboard, users, sources, AI, analytics, subscriptions, jobs and audit", async () => {
    const s = await import("@dealmind/shared");
    const f = await import("./admin-fixtures");
    const check = (
      schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
      v: unknown,
    ) => {
      const r = schema.safeParse(v);
      expect(r.success, JSON.stringify(r.error)).toBe(true);
    };
    check(s.adminDashboardView, f.adminDashboard());
    check(s.adminUserDetail, f.adminUserDetailFixture());
    for (const src of f.adminSources()) check(s.adminSourceView, src);
    check(s.aiModelConfigView, f.adminAiModels().config);
    check(s.aiUsageView, f.adminAiModels().usage);
    check(s.searchAnalyticsView, f.adminAnalytics());
    check(s.subscriptionAnalyticsView, f.adminSubscriptions());
    check(s.adminJobsView, f.adminJobs());
    for (const e of f.adminAudit()) check(s.adminAuditEntry, e);
  });
});
