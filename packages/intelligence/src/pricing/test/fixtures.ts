/**
 * Pricing fixtures at realistic Indian marketplace price levels (fictional
 * "Acme" products; bank/membership names are only eligibility labels — no
 * real offer is described).
 */
import { type PricingInput, type StockStatus, calculatePricing } from "../engine.js";
import type { EligibilityContext } from "../schemas/offer-conditions.js";
import type { RankCandidate } from "../../ranking/types.js";

export const NOW = new Date("2026-11-15T12:00:00Z");
export const DAY = 86_400_000;
export const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

/** ₹ → paise for fixtures (integers only). */
export const rs = (rupees: number) => rupees * 100;

export const promo = (p: Record<string, unknown>) => ({ verified: false, ...p });

/** One snapshot per day for `days` days ending `endDaysAgo` days ago. */
export function daily(price: number, days: number, endDaysAgo = 1) {
  return Array.from({ length: days }, (_, i) => ({
    sellingPricePaise: price,
    observedAt: daysAgo(endDaysAgo + days - 1 - i),
  }));
}

export function input(over: Partial<PricingInput> = {}): PricingInput {
  return {
    offerId: "00000000-0000-7000-8000-000000000001",
    sellingPricePaise: rs(24_999),
    mrpPaise: rs(29_999),
    shippingPaise: 0,
    offerConditions: {},
    observedAt: NOW,
    stockStatus: "IN_STOCK",
    launchDate: null,
    snapshots: [],
    ...over,
  };
}

let seq = 0;
export function candidate(
  over: {
    id?: string;
    source?: string;
    selling?: number;
    mrp?: number | null;
    shipping?: number | null;
    stock?: StockStatus;
    launchDate?: Date | null;
    conditions?: unknown;
    snapshots?: PricingInput["snapshots"];
    brand?: string;
    attributes?: Record<string, unknown>;
    category?: string[];
    title?: string;
    observedAt?: Date;
    productId?: string;
    variantId?: string;
  } = {},
  eligibility: EligibilityContext = {},
): RankCandidate {
  seq += 1;
  const offerId = over.id ?? `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`;
  return {
    offerId,
    productId: over.productId ?? `10000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    variantId: over.variantId ?? `20000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    sourceSlug: over.source ?? "mock_alpha",
    sourceName: over.source ?? "mock_alpha",
    title: over.title ?? "Acme Nova 7 5G (Midnight Black, 8GB RAM, 128GB Storage)",
    productName: "Acme Nova 7 5G",
    brand: over.brand ?? "Acme",
    categoryPath: over.category ?? ["smartphones", "mobiles", "electronics"],
    stockStatus: over.stock ?? "IN_STOCK",
    launchDate: over.launchDate ?? null,
    variantAttributes: over.attributes ?? { ram_gb: 8, storage_gb: 128, color: "Midnight Black" },
    specifications: {},
    pricing: calculatePricing(
      input({
        offerId,
        sellingPricePaise: over.selling ?? rs(24_999),
        mrpPaise: over.mrp === undefined ? rs(29_999) : over.mrp,
        shippingPaise: over.shipping === undefined ? 0 : over.shipping,
        offerConditions: over.conditions ?? {},
        stockStatus: over.stock ?? "IN_STOCK",
        launchDate: over.launchDate ?? null,
        snapshots: over.snapshots ?? [],
        observedAt: over.observedAt ?? NOW,
      }),
      eligibility,
      NOW,
    ),
  };
}
