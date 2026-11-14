import { describe, expect, it } from "vitest";
import { productListQuery, specFilters } from "./contracts.js";
import { MoneyError, paiseFromDb, paiseFromDbOrNull } from "./money.js";

describe("specFilters", () => {
  it("parses key:value pairs, numeric values as numbers and text lower-cased", () => {
    expect(specFilters.parse(["ram_gb:8", "color_family:Black"])).toEqual({
      ram_gb: 8,
      color_family: "black",
    });
    expect(specFilters.parse("storage_gb:256")).toEqual({ storage_gb: 256 });
  });
  it("rejects malformed filters and unsafe keys", () => {
    for (const bad of ["ram", ":8", "RAM:8", "a b:1", "x:", "1ram:8"]) {
      expect(specFilters.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("productListQuery", () => {
  it("rejects unknown keys and inverted ranges", () => {
    expect(productListQuery.safeParse({ userId: "x" }).success).toBe(false);
    expect(productListQuery.safeParse({ minPricePaise: "500", maxPricePaise: "100" }).success).toBe(
      false,
    );
    expect(
      productListQuery.safeParse({ launchedAfter: "2025-01-01", launchedBefore: "2024-01-01" })
        .success,
    ).toBe(false);
  });
  it("coerces query-string values", () => {
    const q = productListQuery.parse({ minPricePaise: "100", inStock: "true", page: "2" });
    expect(q).toMatchObject({ minPricePaise: 100, inStock: true, page: 2, sort: "relevance" });
  });
});

describe("paiseFromDb", () => {
  it("converts BIGINT paise safely and refuses precision loss", () => {
    expect(paiseFromDb(2_500_000_000n)).toBe(2_500_000_000);
    expect(paiseFromDbOrNull(null)).toBeNull();
    expect(() => paiseFromDb(2n ** 60n)).toThrow(MoneyError);
    expect(() => paiseFromDb(-1n)).toThrow(MoneyError);
  });
});
