/** The test fixtures must satisfy the real API contracts (so UI tests can't drift from the API). */
import {
  productPricingView,
  searchDetail as searchDetailSchema,
  searchResultView,
} from "@dealmind/shared";
import { describe, expect, it } from "vitest";
import { productPricing, searchDetail, searchResult } from "./fixtures";

describe("fixtures match the shared Zod contracts", () => {
  it("search result, product pricing and search detail", () => {
    expect(searchResultView.safeParse(searchResult()).success).toBe(true);
    expect(productPricingView.safeParse(productPricing()).success).toBe(true);
    expect(searchDetailSchema.safeParse(searchDetail()).success).toBe(true);
  });
});
