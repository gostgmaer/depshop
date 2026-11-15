/**
 * EMI cost transparency. Interest, processing fees and the total cost are
 * shown separately; an EMI plan is never a discount. Costs are only computed
 * from what the source states (installment, total interest, or an explicit
 * no-cost plan); a bare interest rate is not turned into an estimated cost.
 */
import { bigPaise, paiseFromBig } from "@dealmind/shared";
import type { StoredEmi } from "../schemas/offer-conditions.js";

export type EmiCostLabel =
  /** Total payable equals the price (e.g. a genuine no-cost EMI without fees). */
  | "NO_EXTRA_COST"
  /** Costs more than paying the price upfront. */
  | "COSTS_MORE"
  /** Total cost can't be determined from the stated terms. */
  | "COST_NOT_STATED"
  /** Stated installments add up to less than the price: inconsistent source data. */
  | "INCONSISTENT";

export interface EmiAnalysis {
  tenureMonths: number;
  bank: string | null;
  description: string | null;
  interestRateBp: number | null;
  monthlyInstallmentPaise: number | null;
  interestPaise: number | null;
  processingFeePaise: number | null;
  /** Price financed (delivered price). */
  principalPaise: number;
  totalPayablePaise: number | null;
  /** Total − principal (≥ 0 when known). Never presented as a saving. */
  extraCostPaise: number | null;
  noCostClaimed: boolean;
  label: EmiCostLabel;
  flags: string[];
}

export function analyzeEmi(option: StoredEmi, principalPaise: bigint): EmiAnalysis {
  const fee = option.processingFeePaise === undefined ? null : bigPaise(option.processingFeePaise);
  const flags: string[] = [];
  let total: bigint | null = null;
  let interest: bigint | null =
    option.interestPaise === undefined ? null : bigPaise(option.interestPaise);
  if (option.monthlyInstallmentPaise !== undefined) {
    const installments = bigPaise(option.monthlyInstallmentPaise) * BigInt(option.tenureMonths);
    total = installments + (fee ?? 0n);
    if (interest === null && installments >= principalPaise)
      interest = installments - principalPaise;
  } else if (interest !== null) {
    total = principalPaise + interest + (fee ?? 0n);
  } else if (option.noCostClaimed) {
    // Interest waived as claimed (unverified); fees still count.
    total = principalPaise + (fee ?? 0n);
    flags.push("NO_COST_CLAIM_UNVERIFIED");
  }
  if (fee === null) flags.push("PROCESSING_FEE_NOT_STATED");

  let label: EmiCostLabel;
  let extra: bigint | null = null;
  if (total === null) {
    label = "COST_NOT_STATED";
  } else if (total < principalPaise) {
    label = "INCONSISTENT";
    flags.push("INSTALLMENTS_BELOW_PRICE");
  } else {
    extra = total - principalPaise;
    label = extra === 0n ? "NO_EXTRA_COST" : "COSTS_MORE";
    if (option.noCostClaimed && extra > 0n) flags.push("NO_COST_CLAIM_HAS_CHARGES");
  }
  return {
    tenureMonths: option.tenureMonths,
    bank: option.bank ?? null,
    description: option.description ?? null,
    interestRateBp: option.interestRateBp ?? null,
    monthlyInstallmentPaise: option.monthlyInstallmentPaise ?? null,
    interestPaise: interest === null ? null : paiseFromBig(interest),
    processingFeePaise: fee === null ? null : paiseFromBig(fee),
    principalPaise: paiseFromBig(principalPaise),
    totalPayablePaise: total === null ? null : paiseFromBig(total),
    extraCostPaise: extra === null ? null : paiseFromBig(extra),
    noCostClaimed: option.noCostClaimed,
    label,
    flags,
  };
}
