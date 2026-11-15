import { describe, expect, it } from "vitest";
import { createSearchInput, searchResultsQuery } from "./contracts.js";
import { specFilterValue, specLabel, specValueLabel } from "./spec-labels.js";

describe("spec labels", () => {
  it("labels known and unknown canonical keys", () => {
    expect(specLabel("ram_gb")).toBe("RAM");
    expect(specLabel("refresh_rate_hz")).toBe("Refresh rate");
    expect(specLabel("panel_type")).toBe("Panel type");
    expect(specLabel("noise_level_db")).toBe("Noise level db");
    expect(specLabel("wattage_w")).toBe("Wattage (W)");
  });

  it("formats values with their unit, and TB for whole terabytes", () => {
    expect(specValueLabel("ram_gb", 8)).toBe("8 GB");
    expect(specValueLabel("storage_gb", 1024)).toBe("1 TB");
    expect(specValueLabel("capacity_ton", 1.5)).toBe("1.5 ton");
    expect(specValueLabel("panel_type", "OLED")).toBe("OLED");
  });

  it("sends GB capacities with their unit so the normalizer parses them back", () => {
    expect(specFilterValue("ram_gb", 8)).toBe("8 GB");
    expect(specFilterValue("capacity_l", 7)).toBe("7");
  });
});

describe("search contract additions", () => {
  it("accepts the new general filters and rejects out-of-range ones", () => {
    const ok = createSearchInput.safeParse({
      query: "a phone",
      filters: { minDiscountPercent: 10, launchedWithinDays: 90, inStockOnly: true },
    });
    expect(ok.success).toBe(true);
    expect(
      createSearchInput.safeParse({ query: "a phone", filters: { launchedWithinDays: 45 } })
        .success,
    ).toBe(false);
    expect(
      createSearchInput.safeParse({ query: "a phone", filters: { minDiscountPercent: 95 } })
        .success,
    ).toBe(false);
    // Ownership is never taken from the client.
    expect(createSearchInput.safeParse({ query: "a phone", userId: "x" }).success).toBe(false);
  });

  it("defaults result sort to the stored rank", () => {
    expect(searchResultsQuery.parse({})).toEqual({ page: 1, pageSize: 20, sort: "rank" });
    expect(searchResultsQuery.safeParse({ sort: "affiliate" }).success).toBe(false);
  });
});
