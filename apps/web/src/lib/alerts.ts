/** Plain-language alert conditions, statuses and the honest description of tracking. */
import type { AlertStatusValue, AlertTypeValue } from "@dealmind/shared";
import type { PriceAlert } from "@/types/api";
import { rupees } from "./format";

export const ALERT_TYPE_LABEL: Record<AlertTypeValue, string> = {
  TARGET_PRICE: "Price at or below a target",
  PRICE_BELOW: "Price below a target",
  PERCENT_DROP: "Price drops by a percentage",
  HISTORICAL_LOW: "Lowest observed price in a period",
  PRICE_DROP: "Price drops on a marketplace",
  PRICE_CHANGE: "Price changes by an amount",
  BACK_IN_STOCK: "Back in stock",
};

export const ALERT_STATUS_LABEL: Record<
  AlertStatusValue,
  { label: string; tone: "ai" | "neutral" | "success" | "warning" }
> = {
  ACTIVE: { label: "Active", tone: "ai" },
  PAUSED: { label: "Paused", tone: "neutral" },
  TRIGGERED: { label: "Triggered", tone: "success" },
  EXPIRED: { label: "Ended", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

/** What the alert waits for, from its stored parameters. */
export function describeAlert(
  a: Pick<
    PriceAlert,
    "type" | "targetPricePaise" | "dropPercentBp" | "baselinePricePaise" | "historicalWindowDays"
  > &
    Partial<Pick<PriceAlert, "minChangePaise">>,
): string {
  const min = a.minChangePaise ? ` by ${rupees(a.minChangePaise)} or more` : "";
  switch (a.type) {
    case "TARGET_PRICE":
      return `At or below ${rupees(a.targetPricePaise)}`;
    case "PRICE_BELOW":
      return `Below ${rupees(a.targetPricePaise)}`;
    case "PERCENT_DROP":
      return `Drops ${Math.floor((a.dropPercentBp ?? 0) / 100)}%${a.baselinePricePaise ? ` from ${rupees(a.baselinePricePaise)}` : " (baseline set at the next price check)"}`;
    case "HISTORICAL_LOW":
      return `Lowest observed in ${a.historicalWindowDays ?? 90} days`;
    case "PRICE_DROP":
      return `Price drops${min}`;
    case "PRICE_CHANGE":
      return min ? `Price changes${min}` : "Any price change";
    case "BACK_IN_STOCK":
      return "Back in stock";
  }
}

export const isTargetAlert = (t: AlertTypeValue) => t === "TARGET_PRICE" || t === "PRICE_BELOW";

export const TRACKING_EXPLAINER =
  "DealMind re-checks prices in the background on each connected marketplace — every 30 minutes to 12 hours, more often for products many people follow — and notifies you in the app and by email, as set in your preferences. Marketplaces without an authorized connection aren't checked.";
