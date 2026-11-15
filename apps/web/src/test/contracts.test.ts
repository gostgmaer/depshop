/** The test fixtures must satisfy the real API contracts (so UI tests can't drift from the API). */
import {
  categoryFilters as categoryFiltersSchema,
  productPricingView,
  searchDetail as searchDetailSchema,
  searchResultView,
} from "@dealmind/shared";
import { describe, expect, it } from "vitest";
import {
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
    expect(categoryFiltersSchema.safeParse(categoryFilters("washing-machines")).success).toBe(true);
  });
});
