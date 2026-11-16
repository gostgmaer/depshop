/** Plain-language alert conditions and the honest description of how tracking works. */
import type { AlertTypeValue } from "@dealmind/shared";
import type { PriceAlert } from "@/types/api";
import { rupees } from "./format";

export const ALERT_TYPE_LABEL: Record<AlertTypeValue, string> = {
  TARGET_PRICE: "Price at or below a target",
  PRICE_BELOW: "Price below a target",
  PERCENT_DROP: "Price drops by a percentage",
  HISTORICAL_LOW: "Lowest observed price in a period",
  PRICE_CHANGE: "Any price change",
  BACK_IN_STOCK: "Back in stock",
};

/** What the alert waits for, from its stored parameters. */
export function describeAlert(
  a: Pick<
    PriceAlert,
    "type" | "targetPricePaise" | "dropPercentBp" | "baselinePricePaise" | "historicalWindowDays"
  >,
): string {
  switch (a.type) {
    case "TARGET_PRICE":
      return `At or below ${rupees(a.targetPricePaise)}`;
    case "PRICE_BELOW":
      return `Below ${rupees(a.targetPricePaise)}`;
    case "PERCENT_DROP":
      return `Drops ${Math.floor((a.dropPercentBp ?? 0) / 100)}%${a.baselinePricePaise ? ` from ${rupees(a.baselinePricePaise)}` : " (baseline set at the next price check)"}`;
    case "HISTORICAL_LOW":
      return `Lowest observed in ${a.historicalWindowDays ?? 90} days`;
    case "PRICE_CHANGE":
      return "Any price change";
    case "BACK_IN_STOCK":
      return "Back in stock";
  }
}

export const TRACKING_EXPLAINER =
  "DealMind re-checks prices in the background on each connected marketplace — every 30 minutes to 12 hours, more often for products many people follow — and notifies you in the app and by email, as set in your preferences. Marketplaces without an authorized connection aren't checked.";
