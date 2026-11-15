/**
 * Direct discount = MRP − selling price; % = (MRP − selling) / MRP × 100.
 *
 * BigInt arithmetic; the percentage is stored in basis points rounded DOWN
 * (25.99…% → 2599 bp) so a discount is never overstated. No MRP → no
 * percentage at all (never fabricated). Cashback, bank, coupon and other
 * conditional benefits are never part of the direct discount.
 */
import { bigPaise, formatBasisPoints, paiseFromBig, ratioBp } from "@dealmind/shared";

export type DirectDiscountStatus =
  /** Valid MRP and selling price (discount may be 0). */
  | "OK"
  /** The source didn't state an MRP: no discount can be computed. */
  | "NO_MRP"
  /** MRP of zero: unusable. */
  | "INVALID_MRP"
  /** Selling price above MRP without an explicit source-stated exception: data problem. */
  | "ABOVE_MRP"
  /** Selling price above MRP with an explicit pricing exception: no discount. */
  | "ABOVE_MRP_EXCEPTION";

export interface DirectDiscount {
  status: DirectDiscountStatus;
  mrpPaise: number | null;
  sellingPricePaise: number;
  /** Null unless status is OK or ABOVE_MRP_EXCEPTION. */
  amountPaise: number | null;
  /** Basis points (2599 = 25.99%), rounded down. */
  percentBp: number | null;
  /** Display string, e.g. "25.99%". */
  percentText: string | null;
}

export class PriceValidationError extends Error {
  override readonly name = "PriceValidationError";
}

export function directDiscount(
  sellingPaise: bigint | number,
  mrpPaise: bigint | number | null | undefined,
  opts: { sellingAboveMrpException?: boolean } = {},
): DirectDiscount {
  if (typeof sellingPaise === "number" ? sellingPaise < 0 : sellingPaise < 0n) {
    throw new PriceValidationError("Selling price must not be negative");
  }
  const selling = bigPaise(sellingPaise);
  const base = { sellingPricePaise: paiseFromBig(selling) };
  if (mrpPaise === null || mrpPaise === undefined) {
    return {
      status: "NO_MRP",
      mrpPaise: null,
      ...base,
      amountPaise: null,
      percentBp: null,
      percentText: null,
    };
  }
  const mrp = bigPaise(mrpPaise);
  const mrpOut = paiseFromBig(mrp);
  if (mrp === 0n) {
    return {
      status: "INVALID_MRP",
      mrpPaise: mrpOut,
      ...base,
      amountPaise: null,
      percentBp: null,
      percentText: null,
    };
  }
  if (selling > mrp) {
    return opts.sellingAboveMrpException
      ? {
          status: "ABOVE_MRP_EXCEPTION",
          mrpPaise: mrpOut,
          ...base,
          amountPaise: 0,
          percentBp: 0,
          percentText: "0%",
        }
      : {
          status: "ABOVE_MRP",
          mrpPaise: mrpOut,
          ...base,
          amountPaise: null,
          percentBp: null,
          percentText: null,
        };
  }
  const amount = mrp - selling;
  const percentBp = ratioBp(amount, mrp);
  return {
    status: "OK",
    mrpPaise: mrpOut,
    ...base,
    amountPaise: paiseFromBig(amount),
    percentBp,
    percentText: formatBasisPoints(percentBp),
  };
}
