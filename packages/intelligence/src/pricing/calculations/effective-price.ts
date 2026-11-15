/**
 * The price ladder of one offer (all BigInt internally, paise numbers out):
 *
 *   A. base selling price            — the marketplace's current price
 *   B. delivered price               — A + shipping + mandatory fees
 *   C. coupon price                  — B − best VERIFIED, eligible coupon
 *   D. bank-offer price              — B − best VERIFIED, eligible bank offer
 *   G. membership price              — B − best VERIFIED benefit of a membership the user has
 *   E. cashback                      — shown separately; "after cashback" is a
 *                                      reference value, never a payable price
 *   F. exchange                      — shown separately; never in default ranking
 *   H. EMI                           — cost breakdown per plan (see emi.ts)
 *
 * Benefits are not stacked (combinability is rarely stated and never
 * assumed): the best verified payable price is B minus the single largest
 * applicable benefit. Percent benefits and minimum-transaction checks use the
 * selling price (the order value); deductions apply to the delivered price.
 */
import { bigPaise, maxBig, paiseFromBig } from "@dealmind/shared";
import { type EvaluatedBenefit, evaluateBenefit } from "../offer-conditions/evaluate.js";
import type { EligibilityContext, ParsedOfferConditions } from "../schemas/offer-conditions.js";
import { type EmiAnalysis, analyzeEmi } from "./emi.js";

export type PayableBasis = "DELIVERED" | "COUPON" | "BANK_OFFER" | "MEMBERSHIP";

export interface PriceLadder {
  basePaise: number;
  shippingPaise: number;
  /** False when the source didn't state shipping (treated as 0, flagged). */
  shippingKnown: boolean;
  mandatoryFeesPaise: number;
  deliveredPaise: number;
  couponPricePaise: number | null;
  bankOfferPricePaise: number | null;
  membershipPricePaise: number | null;
  /** Lowest price payable now with verified, eligible benefits (no stacking). */
  bestVerifiedPayablePaise: number;
  bestVerifiedPayableBasis: PayableBasis;
  /** Verified cashback credited later (not deducted). */
  cashbackPaise: number | null;
  /** bestVerifiedPayable − cashback: a reference only, NOT a payable price. */
  cashbackAdjustedReferencePaise: number | null;
  /** Largest stated exchange benefit (depends on a device; never ranked). */
  exchangeMaxBenefitPaise: number | null;
}

export interface PriceLadderResult {
  prices: PriceLadder;
  benefits: EvaluatedBenefit[];
  fees: { type: string; description: string; amountPaise: number; mandatory: boolean }[];
  emi: EmiAnalysis[];
  flags: string[];
}

function best(benefits: EvaluatedBenefit[], type: EvaluatedBenefit["type"]): bigint | null {
  let top: bigint | null = null;
  for (const b of benefits) {
    if (b.type !== type || !b.appliesToPayable || b.benefitPaise === null) continue;
    const v = BigInt(b.benefitPaise);
    top = top === null ? v : maxBig(top, v);
  }
  return top;
}

export function priceLadder(
  offer: { sellingPricePaise: bigint | number; shippingPaise: bigint | number | null },
  conditions: ParsedOfferConditions,
  ctx: EligibilityContext,
  now: Date,
): PriceLadderResult {
  const selling = bigPaise(offer.sellingPricePaise);
  const flags: string[] = [];
  const shippingKnown = offer.shippingPaise !== null;
  if (!shippingKnown) flags.push("SHIPPING_NOT_STATED");
  const shipping = shippingKnown ? bigPaise(offer.shippingPaise!) : 0n;
  let fees = 0n;
  for (const f of conditions.fees) if (f.mandatory) fees += bigPaise(f.amountPaise);
  const delivered = selling + shipping + fees;

  const benefits = conditions.promotions.map((p) => evaluateBenefit(p, selling, ctx, now));
  const after = (v: bigint | null) =>
    v === null ? null : delivered - (v > delivered ? delivered : v);
  const coupon = after(best(benefits, "COUPON"));
  const bank = after(best(benefits, "BANK_OFFER"));
  const membership = after(best(benefits, "MEMBERSHIP"));

  let payable = delivered;
  let basis: PayableBasis = "DELIVERED";
  for (const [p, b] of [
    [coupon, "COUPON"],
    [bank, "BANK_OFFER"],
    [membership, "MEMBERSHIP"],
  ] as const) {
    if (p !== null && p < payable) {
      payable = p;
      basis = b;
    }
  }

  let cashback: bigint | null = null;
  let exchange: bigint | null = null;
  for (const b of benefits) {
    if (b.benefitPaise === null) continue;
    const v = BigInt(b.benefitPaise);
    // Cashback counts only when verified; exchange is listed whatever its status (never ranked).
    if (b.type === "CASHBACK" && b.status === "VERIFIED")
      cashback = cashback === null ? v : maxBig(cashback, v);
    if (b.type === "EXCHANGE") exchange = exchange === null ? v : maxBig(exchange, v);
  }
  if (conditions.dropped.length) flags.push("MALFORMED_CONDITIONS_IGNORED");

  return {
    prices: {
      basePaise: paiseFromBig(selling),
      shippingPaise: paiseFromBig(shipping),
      shippingKnown,
      mandatoryFeesPaise: paiseFromBig(fees),
      deliveredPaise: paiseFromBig(delivered),
      couponPricePaise: coupon === null ? null : paiseFromBig(coupon),
      bankOfferPricePaise: bank === null ? null : paiseFromBig(bank),
      membershipPricePaise: membership === null ? null : paiseFromBig(membership),
      bestVerifiedPayablePaise: paiseFromBig(payable),
      bestVerifiedPayableBasis: basis,
      cashbackPaise: cashback === null ? null : paiseFromBig(cashback),
      cashbackAdjustedReferencePaise:
        cashback === null
          ? null
          : paiseFromBig(payable - (cashback > payable ? payable : cashback)),
      exchangeMaxBenefitPaise: exchange === null ? null : paiseFromBig(exchange),
    },
    benefits,
    fees: conditions.fees.map((f) => ({ ...f })),
    emi: conditions.emi.map((e) => analyzeEmi(e, delivered)),
    flags,
  };
}
