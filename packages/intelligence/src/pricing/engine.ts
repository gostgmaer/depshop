/**
 * Pricing engine: one offer → direct discount, price ladder, conditional
 * benefits, fees, EMI transparency, price history and the genuine-discount
 * assessment. Pure and deterministic (the clock is an argument); all money in
 * BigInt internally, paise numbers (safe integers) in the result.
 */
import { paiseFromDb, paiseFromDbOrNull } from "@dealmind/shared";
import { type DirectDiscount, directDiscount } from "./calculations/direct-discount.js";
import { type PriceLadderResult, priceLadder } from "./calculations/effective-price.js";
import {
  DEFAULT_HISTORY_OPTIONS,
  type HistoryOptions,
  type Observation,
  type PriceHistoryStats,
  priceHistory,
} from "./historical-prices/history.js";
import { type PriceAssessment, assessPrice } from "./pricing.js";
import { type EligibilityContext, parseOfferConditions } from "./schemas/offer-conditions.js";

export type StockStatus = "IN_STOCK" | "LIMITED" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";

export interface PricingInput {
  offerId: string;
  sellingPricePaise: bigint | number;
  mrpPaise: bigint | number | null;
  shippingPaise: bigint | number | null;
  /** ProductOffer.offerConditions as stored. */
  offerConditions: unknown;
  observedAt: Date;
  stockStatus: StockStatus;
  launchDate?: Date | null;
  /** This offer's snapshots (any order; the longest history window is used). */
  snapshots: Observation[];
}

export interface PricingResult extends PriceLadderResult {
  offerId: string;
  currency: "INR";
  /** When this price was observed (never presented as live beyond that). */
  observedAt: string;
  priceType: "LISTED" | "VERIFIED_CHECKOUT" | "INDICATIVE" | null;
  stockStatus: StockStatus;
  directDiscount: DirectDiscount;
  pricingException: { reason: string } | null;
  history: PriceHistoryStats;
  /** Genuine discount vs this offer's own price history (90-day median). */
  assessment: PriceAssessment;
}

export function calculatePricing(
  input: PricingInput,
  eligibility: EligibilityContext = {},
  now: Date = new Date(),
  historyOptions: Partial<HistoryOptions> = {},
): PricingResult {
  const conditions = parseOfferConditions(input.offerConditions);
  const discount = directDiscount(input.sellingPricePaise, input.mrpPaise, {
    sellingAboveMrpException: conditions.pricingException !== null,
  });
  const ladder = priceLadder(
    { sellingPricePaise: input.sellingPricePaise, shippingPaise: input.shippingPaise },
    conditions,
    eligibility,
    now,
  );
  const flags = [...ladder.flags];
  if (discount.status === "NO_MRP") flags.push("NO_MRP");
  if (discount.status === "INVALID_MRP") flags.push("INVALID_MRP");
  if (discount.status === "ABOVE_MRP") flags.push("SELLING_PRICE_ABOVE_MRP");
  if (conditions.priceType === "INDICATIVE") flags.push("INDICATIVE_PRICE");

  const opts = { ...DEFAULT_HISTORY_OPTIONS, ...historyOptions };
  const history = priceHistory(
    {
      currentPaise: input.sellingPricePaise,
      currentObservedAt: input.observedAt,
      snapshots: input.snapshots,
      launchDate: input.launchDate ?? null,
    },
    now,
    opts,
  );
  const assessment = assessPrice(
    {
      sellingPricePaise: paiseFromDb(input.sellingPricePaise),
      // An MRP that can't support a discount isn't passed on as one.
      mrpPaise: discount.status === "OK" ? paiseFromDbOrNull(input.mrpPaise) : null,
      shippingPaise: paiseFromDbOrNull(input.shippingPaise),
    },
    input.snapshots.map((s) => ({
      sellingPricePaise: paiseFromDb(s.sellingPricePaise),
      observedAt: s.observedAt,
    })),
    now,
  );
  return {
    offerId: input.offerId,
    currency: "INR",
    observedAt: input.observedAt.toISOString(),
    priceType: conditions.priceType,
    stockStatus: input.stockStatus,
    directDiscount: discount,
    pricingException: conditions.pricingException
      ? { reason: conditions.pricingException.reason }
      : null,
    ...ladder,
    flags,
    history,
    assessment,
  };
}
