/**
 * Price change detection between the stored offer and a fresh observation.
 * Integer paise and basis points only. A missing price is never zero: only
 * two valid observations are compared, and an implausible jump must be seen
 * twice in a row before it is accepted.
 */
import { signedRatioBp } from "@dealmind/shared";

export type Stock = "IN_STOCK" | "LIMITED" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";

export interface Observation {
  sellingPricePaise: number;
  mrpPaise: number | null;
  shippingPaise: number | null;
  stockStatus: Stock;
}

export type ChangeKind = "UNCHANGED" | "PRICE_DECREASED" | "PRICE_INCREASED" | "OTHER_CHANGED";

export interface Change {
  kind: ChangeKind;
  /** new − previous (paise). */
  changePaise: number;
  /** (new − previous) / previous in basis points, truncated toward zero. */
  changeBp: number;
  priceChanged: boolean;
  stockChanged: boolean;
  mrpChanged: boolean;
  shippingChanged: boolean;
}

export function detectChange(prev: Observation, next: Observation): Change {
  const changePaise = next.sellingPricePaise - prev.sellingPricePaise;
  const changeBp = signedRatioBp(BigInt(changePaise), BigInt(prev.sellingPricePaise));
  const stockChanged = prev.stockStatus !== next.stockStatus;
  const mrpChanged = prev.mrpPaise !== next.mrpPaise;
  const shippingChanged = prev.shippingPaise !== next.shippingPaise;
  const kind: ChangeKind =
    changePaise < 0
      ? "PRICE_DECREASED"
      : changePaise > 0
        ? "PRICE_INCREASED"
        : stockChanged || mrpChanged || shippingChanged
          ? "OTHER_CHANGED"
          : "UNCHANGED";
  return {
    kind,
    changePaise,
    changeBp,
    priceChanged: changePaise !== 0,
    stockChanged,
    mrpChanged,
    shippingChanged,
  };
}

/** Drops of more than 80% or rises above 5× are held for confirmation. */
export const IMPLAUSIBLE_DROP_BP = -8_000;
export const IMPLAUSIBLE_RISE_BP = 40_000;

export function isImplausible(change: Change): boolean {
  return change.changeBp <= IMPLAUSIBLE_DROP_BP || change.changeBp >= IMPLAUSIBLE_RISE_BP;
}

export interface ObservationProblem {
  code: "INDICATIVE_PRICE" | "CURRENCY" | "NON_POSITIVE_PRICE" | "BAD_MRP" | "BAD_SHIPPING";
  message: string;
}

/**
 * Checks beyond the connector schema: only a listed, positive INR price can
 * update an offer. Returns null when the observation is usable.
 */
export function validateObservation(item: {
  priceType: string;
  currency: string;
  sellingPricePaise: number;
  mrpPaise?: number | null | undefined;
  shippingPaise?: number | null | undefined;
}): ObservationProblem | null {
  if (item.priceType === "INDICATIVE")
    return { code: "INDICATIVE_PRICE", message: "Indicative price, not an offer price" };
  if (item.currency !== "INR") return { code: "CURRENCY", message: `Currency ${item.currency}` };
  if (!Number.isSafeInteger(item.sellingPricePaise) || item.sellingPricePaise <= 0)
    return { code: "NON_POSITIVE_PRICE", message: "Selling price must be a positive amount" };
  if (item.mrpPaise != null && (!Number.isSafeInteger(item.mrpPaise) || item.mrpPaise <= 0))
    return { code: "BAD_MRP", message: "MRP must be positive when stated" };
  if (
    item.shippingPaise != null &&
    (!Number.isSafeInteger(item.shippingPaise) || item.shippingPaise < 0)
  )
    return { code: "BAD_SHIPPING", message: "Shipping can't be negative" };
  return null;
}
