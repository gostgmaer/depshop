/**
 * Zod schemas of pricing/ranking RESULTS (computed by @dealmind/intelligence),
 * shared by the API (response validation) and the web app (types). Used to validate API responses
 * (every money field must be a safe-integer paise value, every status known).
 */
import { z } from "zod";

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signedBp = z.number().int();
const bp = z.number().int().min(0).max(10_000);
const iso = z.string().datetime();

export const directDiscountSchema = z.object({
  status: z.enum(["OK", "NO_MRP", "INVALID_MRP", "ABOVE_MRP", "ABOVE_MRP_EXCEPTION"]),
  mrpPaise: paise.nullable(),
  sellingPricePaise: paise,
  amountPaise: paise.nullable(),
  percentBp: bp.nullable(),
  percentText: z.string().nullable(),
});

export const evaluatedBenefitSchema = z.object({
  type: z.enum(["COUPON", "BANK_OFFER", "CASHBACK", "EXCHANGE", "MEMBERSHIP", "OTHER"]),
  description: z.string(),
  amountPaise: paise.nullable(),
  percentBp: bp.nullable(),
  maxDiscountPaise: paise.nullable(),
  minTransactionPaise: paise.nullable(),
  eligibleBanks: z.array(z.string()),
  paymentMethods: z.array(z.string()),
  cardTypes: z.array(z.string()),
  membership: z.string().nullable(),
  couponCode: z.string().nullable(),
  expiresAt: z.string().nullable(),
  conditions: z.array(z.string()),
  sourceVerified: z.boolean(),
  status: z.enum(["VERIFIED", "UNVERIFIED", "EXPIRED", "INELIGIBLE"]),
  reasons: z.array(z.string()),
  benefitPaise: paise.nullable(),
  appliesToPayable: z.boolean(),
});

export const priceLadderSchema = z.object({
  basePaise: paise,
  shippingPaise: paise,
  shippingKnown: z.boolean(),
  mandatoryFeesPaise: paise,
  deliveredPaise: paise,
  couponPricePaise: paise.nullable(),
  bankOfferPricePaise: paise.nullable(),
  membershipPricePaise: paise.nullable(),
  bestVerifiedPayablePaise: paise,
  bestVerifiedPayableBasis: z.enum(["DELIVERED", "COUPON", "BANK_OFFER", "MEMBERSHIP"]),
  cashbackPaise: paise.nullable(),
  cashbackAdjustedReferencePaise: paise.nullable(),
  exchangeMaxBenefitPaise: paise.nullable(),
});

export const emiAnalysisSchema = z.object({
  tenureMonths: z.number().int(),
  bank: z.string().nullable(),
  description: z.string().nullable(),
  interestRateBp: bp.nullable(),
  monthlyInstallmentPaise: paise.nullable(),
  interestPaise: paise.nullable(),
  processingFeePaise: paise.nullable(),
  principalPaise: paise,
  totalPayablePaise: paise.nullable(),
  extraCostPaise: paise.nullable(),
  noCostClaimed: z.boolean(),
  label: z.enum(["NO_EXTRA_COST", "COSTS_MORE", "COST_NOT_STATED", "INCONSISTENT"]),
  flags: z.array(z.string()),
});

export const lowestClaimSchema = z.object({
  kind: z.enum(["ALL_TIME_LOW", "LOWEST_IN_WINDOW", "NONE"]),
  days: z.number().int().nullable(),
  text: z.string().nullable(),
});

export const priceHistoryStatsSchema = z.object({
  currentPaise: paise,
  firstObservedAt: iso.nullable(),
  observations: z.number().int().min(0),
  windows: z.array(
    z.object({
      days: z.number().int(),
      observations: z.number().int().min(0),
      lowestPaise: paise.nullable(),
      lowestObservedAt: iso.nullable(),
      highestPaise: paise.nullable(),
      averagePaise: paise.nullable(),
      coverageBp: bp,
      currentIsLowest: z.boolean(),
    }),
  ),
  historicalAveragePaise: paise.nullable(),
  previousPricePaise: paise.nullable(),
  previousObservedAt: iso.nullable(),
  changeFromPreviousBp: signedBp.nullable(),
  changeVs30DayAverageBp: signedBp.nullable(),
  trend: z.enum(["FALLING", "RISING", "STABLE", "INSUFFICIENT_DATA"]),
  lowestClaim: lowestClaimSchema,
  recentDrop: z
    .object({ referencePaise: paise, dropPaise: paise, dropBp: bp, since: iso })
    .nullable(),
});

export const priceAssessmentSchema = z.object({
  sellingPricePaise: paise,
  effectivePricePaise: paise,
  mrpPaise: paise.nullable(),
  claimedDiscountBp: bp,
  claimedSavingsPaise: paise,
  genuineDiscountBp: bp,
  verdict: z.enum(["GENUINE", "NOT_GENUINE", "INSUFFICIENT_HISTORY"]),
  history: z.object({
    points: z.number().int(),
    spanDays: z.number().int(),
    minPaise: paise.nullable(),
    medianPaise: paise.nullable(),
    maxPaise: paise.nullable(),
  }),
  reasons: z.array(z.string()),
});

export const pricingResultSchema = z.object({
  offerId: z.string().uuid(),
  currency: z.literal("INR"),
  observedAt: iso,
  priceType: z.enum(["LISTED", "VERIFIED_CHECKOUT", "INDICATIVE"]).nullable(),
  stockStatus: z.enum(["IN_STOCK", "LIMITED", "OUT_OF_STOCK", "PREORDER", "UNKNOWN"]),
  directDiscount: directDiscountSchema,
  pricingException: z.object({ reason: z.string() }).nullable(),
  prices: priceLadderSchema,
  benefits: z.array(evaluatedBenefitSchema),
  fees: z.array(
    z.object({
      type: z.string(),
      description: z.string(),
      amountPaise: paise,
      mandatory: z.boolean(),
    }),
  ),
  emi: z.array(emiAnalysisSchema),
  flags: z.array(z.string()),
  history: priceHistoryStatsSchema,
  assessment: priceAssessmentSchema,
});

const component = bp.nullable();
export const rankedDealSchema = z.object({
  rank: z.number().int().min(1),
  offerId: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
  marketplace: z.object({ slug: z.string(), name: z.string() }),
  title: z.string(),
  sellingPricePaise: paise,
  deliveredPricePaise: paise,
  rankingPricePaise: paise,
  directDiscount: directDiscountSchema,
  conditionalBenefits: z.array(evaluatedBenefitSchema),
  historicalContext: z.object({
    lowestClaim: lowestClaimSchema,
    trend: z.enum(["FALLING", "RISING", "STABLE", "INSUFFICIENT_DATA"]),
    lowest90DaysPaise: paise.nullable(),
    coverage90DaysBp: bp,
    changeVs30DayAverageBp: signedBp.nullable(),
    recentDrop: priceHistoryStatsSchema.shape.recentDrop,
    genuineDiscountVerdict: z.enum(["GENUINE", "NOT_GENUINE", "INSUFFICIENT_HISTORY"]),
  }),
  stockStatus: z.enum(["IN_STOCK", "LIMITED", "OUT_OF_STOCK", "PREORDER", "UNKNOWN"]),
  availabilityConfirmed: z.boolean(),
  score: bp,
  components: z.object({
    price: bp,
    discount: component,
    history: component,
    specMatch: component,
    relevance: component,
    quality: component,
    recency: component,
    priceDrop: component,
  }),
  explanation: z.object({
    summary: z.string(),
    factors: z.array(z.string()),
    versusNext: z.string().nullable(),
  }),
  priceObservedAt: iso,
});

export type PricingResultView = z.infer<typeof pricingResultSchema>;
export type EvaluatedBenefitView = z.infer<typeof evaluatedBenefitSchema>;
export type PriceHistoryStatsView = z.infer<typeof priceHistoryStatsSchema>;
