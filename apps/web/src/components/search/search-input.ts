/**
 * Search form values ↔ the API's createSearchInput (strict Zod contract).
 * Rupee amounts are parsed as strings into integer paise (no floating point).
 * Specification filters are keyed by the canonical keys the category filters
 * endpoint returns, so nothing about a category is hard-coded here.
 */
import {
  type CreateSearchInput,
  SEARCH_SORT_MODES,
  type SearchSortMode,
  USER_RANKING_MODES,
  createSearchInput,
  parseRupeesToPaise,
} from "@dealmind/shared";
import { z } from "zod";

export const SORT_LABEL: Record<SearchSortMode, string> = {
  best_value: "Best value",
  lowest_price: "Lowest price",
  highest_discount: "Highest verified discount",
  recently_launched: "Recently launched",
  price_drop: "Biggest price drop",
  trending_deals: "Trending deals",
  relevance: "Most relevant",
};

/** How each ranking mode orders deals (mirrors @dealmind/intelligence ranking strategies). */
export const SORT_EXPLANATION: Record<SearchSortMode, string> = {
  best_value:
    "Balances delivered price (35%), how well specifications match (20%), verified discount (15%), price-history position (15%) and relevance (15%). A factor without data is left out, never guessed.",
  lowest_price:
    "Cheapest delivered price first: selling price + shipping + mandatory fees. Bank and coupon offers are not deducted.",
  highest_discount:
    "Biggest discount from a validated MRP first. An MRP that can't be validated doesn't count, and conditional offers are never treated as discounts.",
  recently_launched:
    "Products with a known launch date first, newest first (weighted 60% recency, 40% price). Unknown launch dates come last.",
  price_drop:
    "Largest drop against the offer's own recent price history first. Offers without enough history come last.",
  trending_deals:
    "Not available: DealMind collects no popularity data, so this ranks as best value.",
  relevance: "Closest match to your words first.",
};

/** Modes offered in the UI, in display order (affiliate commission is never a factor). */
export const RANKING_CHOICES = USER_RANKING_MODES;

export const DISCOUNT_CHOICES = ["10", "20", "30", "40", "50"] as const;
export const LAUNCH_CHOICES = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 3 months" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
] as const;

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
    subcategory: z.string(),
    brands: z.array(z.string().trim().min(1).max(50)).max(20),
    sortMode: z.union([z.enum(SEARCH_SORT_MODES), z.literal("")]),
    sourceSlugs: z.array(z.string()),
    minDiscount: z.union([z.enum(DISCOUNT_CHOICES), z.literal("")]),
    launchedWithin: z.union([z.enum(["30", "90", "180", "365"]), z.literal("")]),
    inStockOnly: z.boolean(),
    /** Canonical specification key → value text, from the category filters. */
    specs: z.record(z.string()),
  })
  .superRefine((v, ctx) => {
    if (
      v.minPrice &&
      v.maxPrice &&
      parseRupeesToPaise(v.minPrice) > parseRupeesToPaise(v.maxPrice)
    ) {
      ctx.addIssue({ code: "custom", path: ["minPrice"], message: "Minimum is above the maximum" });
    }
    if (Object.values(v.specs).filter(Boolean).length > 10) {
      ctx.addIssue({
        code: "custom",
        path: ["specs"],
        message: "Choose at most 10 specifications",
      });
    }
  });
export type SearchFormValues = z.infer<typeof searchFormSchema>;

export const EMPTY_SEARCH: SearchFormValues = {
  query: "",
  minPrice: "",
  maxPrice: "",
  category: "",
  subcategory: "",
  brands: [],
  sortMode: "",
  sourceSlugs: [],
  minDiscount: "",
  launchedWithin: "",
  inStockOnly: false,
  specs: {},
};

/** "Samsung, OnePlus" → ["Samsung", "OnePlus"] (deduplicated, case-insensitive). */
export function parseBrandList(text: string): string[] {
  const out: string[] = [];
  for (const b of text.split(",").map((x) => x.trim())) {
    if (b && !out.some((x) => x.toLowerCase() === b.toLowerCase())) out.push(b.slice(0, 50));
  }
  return out.slice(0, 20);
}

export function toSearchInput(v: SearchFormValues): CreateSearchInput {
  const brands = parseBrandList(v.brands.join(","));
  const specs = Object.entries(v.specs)
    .filter(([, value]) => value.trim())
    .map(([name, value]) => ({ name, value: value.trim() }))
    .slice(0, 10);
  const category = v.subcategory || v.category;
  const filters = {
    ...(v.minPrice ? { minPricePaise: parseRupeesToPaise(v.minPrice) } : {}),
    ...(v.maxPrice ? { maxPricePaise: parseRupeesToPaise(v.maxPrice) } : {}),
    ...(category ? { category } : {}),
    ...(brands.length ? { brands } : {}),
    ...(v.sourceSlugs.length ? { sourceSlugs: v.sourceSlugs } : {}),
    ...(v.sortMode ? { sortMode: v.sortMode } : {}),
    ...(v.minDiscount ? { minDiscountPercent: Number(v.minDiscount) } : {}),
    ...(v.launchedWithin
      ? { launchedWithinDays: Number(v.launchedWithin) as 30 | 90 | 180 | 365 }
      : {}),
    ...(v.inStockOnly ? { inStockOnly: true } : {}),
    ...(specs.length ? { specs } : {}),
  };
  // Validated against the same contract the API enforces.
  return createSearchInput.parse({
    query: v.query.trim(),
    ...(Object.keys(filters).length ? { filters } : {}),
  });
}

/** Integer paise → editable rupee text ("35000", "35000.50"), without floating point. */
export function rupeesText(paise: unknown): string {
  if (typeof paise !== "number" || !Number.isSafeInteger(paise) || paise < 0) return "";
  const whole = Math.trunc(paise / 100);
  const fraction = paise % 100;
  return fraction ? `${whole}.${String(fraction).padStart(2, "0")}` : String(whole);
}

/**
 * A saved search's query and filters → form values, so a previous search can
 * be edited and run again. Unknown or invalid saved values are dropped.
 */
export function fromSearch(query: string, filters: Record<string, unknown>): SearchFormValues {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const sort = str(filters.sortMode);
  const discount =
    typeof filters.minDiscountPercent === "number" ? String(filters.minDiscountPercent) : "";
  const launched =
    typeof filters.launchedWithinDays === "number" ? String(filters.launchedWithinDays) : "";
  const specs: Record<string, string> = {};
  if (Array.isArray(filters.specs)) {
    for (const s of filters.specs as unknown[]) {
      const spec = s as { name?: unknown; value?: unknown };
      if (typeof spec.name === "string" && typeof spec.value === "string")
        specs[spec.name] = spec.value;
    }
  }
  return {
    ...EMPTY_SEARCH,
    query,
    minPrice: rupeesText(filters.minPricePaise),
    maxPrice: rupeesText(filters.maxPricePaise),
    category: str(filters.category),
    brands: list(filters.brands),
    sortMode: (SEARCH_SORT_MODES as readonly string[]).includes(sort)
      ? (sort as SearchSortMode)
      : "",
    sourceSlugs: list(filters.sourceSlugs),
    minDiscount: (DISCOUNT_CHOICES as readonly string[]).includes(discount)
      ? (discount as SearchFormValues["minDiscount"])
      : "",
    launchedWithin: ["30", "90", "180", "365"].includes(launched)
      ? (launched as SearchFormValues["launchedWithin"])
      : "",
    inStockOnly: filters.inStockOnly === true,
    specs,
  };
}

export const EXAMPLE_QUERIES = [
  "Find a newly launched smartphone under ₹35,000 with 8GB RAM and 256GB storage",
  "Find the highest genuine discount on Samsung smartphones",
  "Find the cheapest laptop with 16GB RAM and 1TB SSD",
  "Compare iPhone prices across Amazon and Flipkart",
  "Find the best washing machine under ₹25,000",
  "Find a recently launched television with the biggest verified discount",
];
