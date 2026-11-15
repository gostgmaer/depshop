/**
 * Schemas of the pricing engine's inputs.
 *
 *  - Stored `ProductOffer.offerConditions` (written by the connector
 *    normalizer, see @dealmind/connectors `toOfferConditions`) is parsed
 *    leniently: one malformed entry is dropped and reported, never guessed at,
 *    and never fails the whole offer.
 *  - `EligibilityContext` is what the USER stated about themselves (their banks,
 *    cards, memberships). The engine never assumes any of it.
 */
import { z } from "zod";

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bp = z.number().int().min(0).max(10_000);

export const PAYMENT_METHODS = [
  "CREDIT_CARD",
  "DEBIT_CARD",
  "UPI",
  "NET_BANKING",
  "WALLET",
  "EMI",
  "COD",
] as const;
export const CARD_TYPES = ["CREDIT", "DEBIT"] as const;

export const BENEFIT_TYPES = [
  "COUPON",
  "BANK_OFFER",
  "CASHBACK",
  "EXCHANGE",
  "MEMBERSHIP",
  "OTHER",
] as const;
export type BenefitType = (typeof BENEFIT_TYPES)[number];

export const storedPromotionSchema = z.object({
  type: z.enum(BENEFIT_TYPES),
  description: z.string().max(500),
  amountPaise: paise.optional(),
  percentBasisPoints: bp.optional(),
  maxAmountPaise: paise.optional(),
  code: z.string().max(50).optional(),
  terms: z.string().max(1000).optional(),
  minTransactionPaise: paise.optional(),
  eligibleBanks: z.array(z.string().max(100)).max(30).optional(),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).max(10).optional(),
  cardTypes: z.array(z.enum(CARD_TYPES)).max(2).optional(),
  membership: z.string().max(100).optional(),
  validFrom: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  conditions: z.array(z.string().max(300)).max(20).optional(),
  verified: z.boolean().default(false),
});
export type StoredPromotion = z.output<typeof storedPromotionSchema>;

export const storedFeeSchema = z.object({
  type: z.string().max(30),
  description: z.string().max(300),
  amountPaise: paise,
  mandatory: z.boolean(),
});
export type StoredFee = z.output<typeof storedFeeSchema>;

export const storedEmiSchema = z.object({
  tenureMonths: z.number().int().min(1).max(60),
  interestRateBp: bp.optional(),
  monthlyInstallmentPaise: paise.optional(),
  interestPaise: paise.optional(),
  processingFeePaise: paise.optional(),
  noCostClaimed: z.boolean().default(false),
  bank: z.string().max(100).optional(),
  description: z.string().max(300).optional(),
});
export type StoredEmi = z.output<typeof storedEmiSchema>;

/** An explicit, source-stated reason why the selling price may exceed the MRP. */
export const pricingExceptionSchema = z.object({
  sellingAboveMrp: z.literal(true),
  reason: z.string().min(1).max(300),
});

export interface ParsedOfferConditions {
  priceType: "LISTED" | "VERIFIED_CHECKOUT" | "INDICATIVE" | null;
  promotions: StoredPromotion[];
  fees: StoredFee[];
  emi: StoredEmi[];
  pricingException: z.output<typeof pricingExceptionSchema> | null;
  /** Entries that failed validation and were ignored (never guessed at). */
  dropped: { field: string; index: number }[];
}

const GROUPS: [string, BenefitType][] = [
  ["coupons", "COUPON"],
  ["bankOffers", "BANK_OFFER"],
  ["cashback", "CASHBACK"],
  ["exchange", "EXCHANGE"],
  ["membership", "MEMBERSHIP"],
  ["other", "OTHER"],
];

function parseList<T>(
  raw: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  field: string,
  dropped: ParsedOfferConditions["dropped"],
  accept: (item: T) => boolean = () => true,
): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  raw.forEach((item, index) => {
    const r = schema.safeParse(item);
    if (r.success && accept(r.data)) out.push(r.data);
    else dropped.push({ field, index });
  });
  return out;
}

export function parseOfferConditions(raw: unknown): ParsedOfferConditions {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const dropped: ParsedOfferConditions["dropped"] = [];
  const promotions: StoredPromotion[] = [];
  for (const [field, type] of GROUPS) {
    // A promotion filed under a group must be of that group's type.
    promotions.push(
      ...parseList(o[field], storedPromotionSchema, field, dropped, (p) => p.type === type),
    );
  }
  const priceType =
    o.priceType === "LISTED" || o.priceType === "VERIFIED_CHECKOUT" || o.priceType === "INDICATIVE"
      ? o.priceType
      : null;
  const exception = pricingExceptionSchema.safeParse(o.pricingException);
  return {
    priceType,
    promotions,
    fees: parseList(o.fees, storedFeeSchema, "fees", dropped),
    emi: parseList(o.emi, storedEmiSchema, "emi", dropped),
    pricingException: exception.success ? exception.data : null,
    dropped,
  };
}

/** What the user stated about their own eligibility. Absent = unknown (never assumed). */
export const eligibilityContextSchema = z
  .object({
    banks: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    cardTypes: z.array(z.enum(CARD_TYPES)).max(2).optional(),
    paymentMethods: z.array(z.enum(PAYMENT_METHODS)).max(10).optional(),
    memberships: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  })
  .strict();
export type EligibilityContext = z.infer<typeof eligibilityContextSchema>;
