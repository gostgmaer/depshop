/**
 * Offer normalization helpers.
 *
 * - Money: rupee amounts from marketplaces become integer paise via the
 *   shared string-based parser (no floating point).
 * - Conditional benefits (coupons, bank offers, cashback, exchange,
 *   membership) are grouped in `offerConditions` and NEVER subtracted from
 *   the selling price; direct discounts are only MRP vs selling price.
 * - The price basis (LISTED / VERIFIED_CHECKOUT / INDICATIVE) and provenance
 *   travel with the offer so nobody presents a listing price as a checkout price.
 */
import type { SourceListing } from "@dealmind/catalog";
import { MoneyError, parseRupeesToPaise } from "@dealmind/shared";
import { ConnectorError } from "../types/errors.js";
import type { NormalizedProduct, Promotion } from "../types/schemas.js";

/** Rupees (number or string like "₹1,24,999.00") → paise; throws INVALID_RESPONSE when unparseable. */
export function rupeesToPaise(value: number | string): number {
  try {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) throw new MoneyError(`invalid amount ${value}`);
      // Fixed 2-decimal string keeps the conversion exact for currency amounts.
      return parseRupeesToPaise(value.toFixed(2));
    }
    return parseRupeesToPaise(value);
  } catch (err) {
    throw new ConnectorError("INVALID_RESPONSE", `Unparseable price: ${String(value)}`, {
      cause: err,
      retryable: false,
    });
  }
}

export interface OfferConditions {
  priceType: NormalizedProduct["priceType"];
  coupons: Promotion[];
  bankOffers: Promotion[];
  cashback: Promotion[];
  exchange: Promotion[];
  membership: Promotion[];
  other: Promotion[];
  provenance: { method: string; provider: string; operation?: string };
}

export function toOfferConditions(p: NormalizedProduct): OfferConditions {
  const by = (t: Promotion["type"]) => p.promotions.filter((x) => x.type === t);
  return {
    priceType: p.priceType,
    coupons: by("COUPON"),
    bankOffers: by("BANK_OFFER"),
    cashback: by("CASHBACK"),
    exchange: by("EXCHANGE"),
    membership: by("MEMBERSHIP"),
    other: by("OTHER"),
    provenance: {
      method: p.provenance.method,
      provider: p.provenance.provider,
      ...(p.provenance.operation ? { operation: p.provenance.operation } : {}),
    },
  };
}

/**
 * Maps a validated connector item to the catalog importer's listing contract
 * (which then normalizes, matches, upserts the offer and appends price history).
 * INDICATIVE (discovery) prices are refused: they are not offers.
 */
export function toSourceListing(p: NormalizedProduct, categorySlug?: string): SourceListing {
  if (p.priceType === "INDICATIVE") {
    throw new ConnectorError(
      "INVALID_RESPONSE",
      "Indicative (discovery) prices cannot be stored as offers",
      {
        retryable: false,
      },
    );
  }
  const specs: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(p.attributes))
    specs[k] = typeof v === "string" ? v.slice(0, 500) : v;
  return {
    externalId: p.externalId,
    title: p.title,
    productUrl: p.productUrl,
    brand: p.brand,
    ...(p.modelNumber ? { modelNumber: p.modelNumber } : {}),
    ...(p.barcode ? { barcode: p.barcode } : {}),
    ...(categorySlug ? { categorySlug } : {}),
    ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
    specifications: specs,
    attributes: p.variant.attributes,
    ...(p.variant.sku ? { sku: p.variant.sku } : {}),
    ...(p.sellerName ? { sellerName: p.sellerName } : {}),
    sellingPricePaise: p.sellingPricePaise,
    ...(p.mrpPaise !== undefined ? { mrpPaise: p.mrpPaise } : {}),
    ...(p.shippingPaise !== undefined ? { shippingPaise: p.shippingPaise } : {}),
    stockStatus: p.stockStatus,
    currency: "INR",
    offerConditions: toOfferConditions(p) as unknown as Record<string, unknown>,
    ...(p.sourceUpdatedAt ? { sourceUpdatedAt: p.sourceUpdatedAt } : {}),
  };
}
