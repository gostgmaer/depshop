/**
 * Conditional-benefit validation (coupon, bank offer, cashback, exchange,
 * membership, other).
 *
 * Status, most decisive first:
 *   EXPIRED     — past `expiresAt`;
 *   INELIGIBLE  — a stated requirement is known to be unmet (minimum
 *                 transaction, the user's bank/card/membership, not yet valid);
 *   UNVERIFIED  — anything not proven: the source didn't verify it, the
 *                 benefit amount isn't stated, the user's eligibility is
 *                 unknown, or there are free-text conditions we can't evaluate;
 *   VERIFIED    — source-verified, every requirement checked and met.
 *
 * Only VERIFIED coupon / bank / membership benefits ever reduce a price, and
 * never by stacking. Cashback and exchange are never deducted from what is
 * payable now.
 */
import { applyBp, bigPaise, minBig, paiseFromBig } from "@dealmind/shared";
import type {
  BenefitType,
  EligibilityContext,
  StoredPromotion,
} from "../schemas/offer-conditions.js";

export type BenefitStatus = "VERIFIED" | "UNVERIFIED" | "EXPIRED" | "INELIGIBLE";

export interface EvaluatedBenefit {
  type: BenefitType;
  description: string;
  amountPaise: number | null;
  percentBp: number | null;
  maxDiscountPaise: number | null;
  minTransactionPaise: number | null;
  eligibleBanks: string[];
  paymentMethods: string[];
  cardTypes: string[];
  membership: string | null;
  couponCode: string | null;
  expiresAt: string | null;
  conditions: string[];
  sourceVerified: boolean;
  status: BenefitStatus;
  /** Machine-readable reasons for the status. */
  reasons: string[];
  /** Value of the benefit at this transaction amount (rounded down), when computable. */
  benefitPaise: number | null;
  /** True when it reduces a payable price (VERIFIED coupon/bank/membership only). */
  appliesToPayable: boolean;
}

/** "HDFC Bank" / "hdfc" / "HDFC BANK LTD." → "hdfc". */
export function bankKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(bank|ltd|limited|ltd\.)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const membershipKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Value of a stated benefit at `transactionPaise`, rounded down and capped. Null if not stated. */
export function benefitValue(p: StoredPromotion, transactionPaise: bigint): bigint | null {
  let value: bigint | null = null;
  if (p.amountPaise !== undefined) value = bigPaise(p.amountPaise);
  else if (p.percentBasisPoints !== undefined)
    value = applyBp(transactionPaise, p.percentBasisPoints);
  if (value === null) return null;
  if (p.maxAmountPaise !== undefined) value = minBig(value, bigPaise(p.maxAmountPaise));
  // A benefit can never exceed the transaction itself.
  return minBig(value, transactionPaise);
}

const DEDUCTIBLE: ReadonlySet<BenefitType> = new Set(["COUPON", "BANK_OFFER", "MEMBERSHIP"]);

export function evaluateBenefit(
  p: StoredPromotion,
  transactionPaise: bigint,
  ctx: EligibilityContext,
  now: Date,
): EvaluatedBenefit {
  const expired: string[] = [];
  const ineligible: string[] = [];
  const unverified: string[] = [];

  if (p.expiresAt && p.expiresAt.getTime() < now.getTime()) expired.push("EXPIRED");
  if (p.validFrom && p.validFrom.getTime() > now.getTime()) ineligible.push("NOT_YET_VALID");

  const value = benefitValue(p, transactionPaise);
  if (value === null) unverified.push("BENEFIT_AMOUNT_NOT_STATED");
  if (p.minTransactionPaise !== undefined && transactionPaise < bigPaise(p.minTransactionPaise)) {
    ineligible.push("MIN_TRANSACTION_NOT_MET");
  }

  // Bank: a bank offer must name its banks; the user must have stated theirs.
  const banks = p.eligibleBanks ?? [];
  if (p.type === "BANK_OFFER" && banks.length === 0) unverified.push("ELIGIBLE_BANKS_NOT_STATED");
  if (banks.length) {
    if (!ctx.banks) unverified.push("USER_BANK_UNKNOWN");
    else if (!ctx.banks.some((b) => banks.some((e) => bankKey(e) === bankKey(b))))
      ineligible.push("USER_BANK_NOT_ELIGIBLE");
  }
  if (p.cardTypes?.length) {
    if (!ctx.cardTypes) unverified.push("USER_CARD_TYPE_UNKNOWN");
    else if (!ctx.cardTypes.some((c) => p.cardTypes!.includes(c)))
      ineligible.push("USER_CARD_TYPE_NOT_ELIGIBLE");
  }
  if (p.paymentMethods?.length) {
    if (!ctx.paymentMethods) unverified.push("USER_PAYMENT_METHOD_UNKNOWN");
    else if (!ctx.paymentMethods.some((m) => p.paymentMethods!.includes(m)))
      ineligible.push("USER_PAYMENT_METHOD_NOT_ELIGIBLE");
  }
  // Membership: required for MEMBERSHIP benefits (and any benefit naming one).
  if (p.type === "MEMBERSHIP" && !p.membership) unverified.push("MEMBERSHIP_NOT_STATED");
  if (p.membership) {
    if (!ctx.memberships) unverified.push("USER_MEMBERSHIP_UNKNOWN");
    else if (!ctx.memberships.some((m) => membershipKey(m) === membershipKey(p.membership!)))
      ineligible.push("USER_NOT_A_MEMBER");
  }
  if (p.conditions?.length) unverified.push("CONDITIONS_NOT_EVALUABLE");
  if (p.type === "OTHER") unverified.push("UNKNOWN_BENEFIT_TYPE");
  if (!p.verified) unverified.push("SOURCE_NOT_VERIFIED");

  const status: BenefitStatus = expired.length
    ? "EXPIRED"
    : ineligible.length
      ? "INELIGIBLE"
      : unverified.length
        ? "UNVERIFIED"
        : "VERIFIED";

  return {
    type: p.type,
    description: p.description,
    amountPaise: p.amountPaise ?? null,
    percentBp: p.percentBasisPoints ?? null,
    maxDiscountPaise: p.maxAmountPaise ?? null,
    minTransactionPaise: p.minTransactionPaise ?? null,
    eligibleBanks: banks,
    paymentMethods: p.paymentMethods ?? [],
    cardTypes: p.cardTypes ?? [],
    membership: p.membership ?? null,
    couponCode: p.code ?? null,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    conditions: [...(p.conditions ?? []), ...(p.terms ? [p.terms] : [])],
    sourceVerified: p.verified,
    status,
    reasons: [...expired, ...ineligible, ...unverified],
    benefitPaise: value === null ? null : paiseFromBig(value),
    appliesToPayable: status === "VERIFIED" && DEDUCTIBLE.has(p.type) && value !== null,
  };
}
