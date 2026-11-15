/**
 * Search form values → the API's createSearchInput (strict Zod contract).
 * Rupee amounts are parsed as strings into integer paise (no floating point).
 */
import {
  type CreateSearchInput,
  SEARCH_SORT_MODES,
  type SearchSortMode,
  createSearchInput,
  parseRupeesToPaise,
} from "@dealmind/shared";
import { z } from "zod";

export const SORT_LABEL: Record<SearchSortMode, string> = {
  best_value: "Best value",
  lowest_price: "Lowest price",
  highest_discount: "Highest verified discount",
  recently_launched: "Recently launched",
  price_drop: "Recent price drops",
  trending_deals: "Trending deals",
  relevance: "Most relevant",
};

const rupeeText = z
  .string()
  .trim()
  .refine((v) => {
    if (!v) return true;
    try {
      parseRupeesToPaise(v);
      return true;
    } catch {
      return false;
    }
  }, "Enter an amount like 35,000");

export const searchFormSchema = z
  .object({
    query: z.string().trim().min(2, "Describe what you are looking for").max(500),
    minPrice: rupeeText,
    maxPrice: rupeeText,
    category: z.string(),
    brands: z.string().max(400),
    sortMode: z.union([z.enum(SEARCH_SORT_MODES), z.literal("")]),
    sourceSlugs: z.array(z.string()),
    ram: z.string(),
    storage: z.string(),
  })
  .superRefine((v, ctx) => {
    if (
      v.minPrice &&
      v.maxPrice &&
      parseRupeesToPaise(v.minPrice) > parseRupeesToPaise(v.maxPrice)
    ) {
      ctx.addIssue({ code: "custom", path: ["minPrice"], message: "Minimum is above the maximum" });
    }
  });
export type SearchFormValues = z.infer<typeof searchFormSchema>;

export const EMPTY_SEARCH: SearchFormValues = {
  query: "",
  minPrice: "",
  maxPrice: "",
  category: "",
  brands: "",
  sortMode: "",
  sourceSlugs: [],
  ram: "",
  storage: "",
};

export function toSearchInput(v: SearchFormValues): CreateSearchInput {
  const brands = [
    ...new Set(
      v.brands
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
  const specs = [
    ...(v.ram ? [{ name: "ram", value: v.ram }] : []),
    ...(v.storage ? [{ name: "storage", value: v.storage }] : []),
  ];
  const filters = {
    ...(v.minPrice ? { minPricePaise: parseRupeesToPaise(v.minPrice) } : {}),
    ...(v.maxPrice ? { maxPricePaise: parseRupeesToPaise(v.maxPrice) } : {}),
    ...(v.category ? { category: v.category } : {}),
    ...(brands.length ? { brands } : {}),
    ...(v.sourceSlugs.length ? { sourceSlugs: v.sourceSlugs } : {}),
    ...(v.sortMode ? { sortMode: v.sortMode } : {}),
    ...(specs.length ? { specs } : {}),
  };
  // Validated against the same contract the API enforces.
  return createSearchInput.parse({
    query: v.query.trim(),
    ...(Object.keys(filters).length ? { filters } : {}),
  });
}

export const EXAMPLE_QUERIES = [
  "Find a smartphone under ₹35,000 with 8GB RAM and 256GB storage",
  "Find the biggest genuine discount on laptops",
  "Compare Samsung S25 prices across marketplaces",
  "Find the cheapest 1.5-ton inverter AC",
];
