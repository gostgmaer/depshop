/**
 * Individual alert conditions, evaluated against one global price check.
 * Pure: the processor loads the data and persists the decision.
 *
 * Price conditions use the delivered price (selling + shipping; shipping not
 * stated counts as 0 and the message says so) of an available offer only.
 * A level-type alert (target, % drop, historical low) notifies when it is
 * met, then again only if the price falls further; once the condition stops
 * holding it re-arms. Cooldowns are enforced atomically by the processor.
 */
import { formatBasisPoints, formatPaise, signedRatioBp } from "@dealmind/shared";
import type { Stock } from "./price-change.js";

export type AlertType =
  | "TARGET_PRICE"
  | "PRICE_BELOW"
  | "PERCENT_DROP"
  | "HISTORICAL_LOW"
  | "PRICE_CHANGE"
  | "BACK_IN_STOCK"
  | "PRICE_DROP";

export type CheckOutcome =
  "UNCHANGED" | "PRICE_DECREASED" | "PRICE_INCREASED" | "OTHER_CHANGED" | "REAPPEARED";

export interface AlertState {
  type: AlertType;
  targetPricePaise: number | null;
  dropPercentBp: number | null;
  baselinePricePaise: number | null;
  historicalWindowDays: number | null;
  lastTriggeredPricePaise: number | null;
  /** PRICE_CHANGE / PRICE_DROP: minimum absolute change that counts (null = any). */
  minChangePaise?: number | null;
}

export interface CheckContext {
  outcome: CheckOutcome;
  sellingPricePaise: number;
  shippingPaise: number | null;
  previousPricePaise: number | null;
  stock: Stock;
  previousStock: Stock | null;
  marketplace: string;
  productName: string;
  /** Lowest delivered price among earlier observations in the window (null = not enough history). */
  priorLowPaise: number | null;
}

export type NotificationKind =
  "TARGET_PRICE_REACHED" | "PRICE_DROP" | "PRICE_CHANGED" | "BACK_IN_STOCK";

export interface Decision {
  outcome: "TRIGGERED" | "NOT_MET" | "INSUFFICIENT_DATA";
  reason: string;
  deliveredPaise: number;
  notification?: { kind: NotificationKind; title: string; body: string };
  /** Clear lastTriggeredPricePaise: the condition no longer holds (re-arm). */
  rearm?: boolean;
  /** PERCENT_DROP: record the first observed price as the baseline. */
  setBaselinePaise?: number;
}

const AVAILABLE: ReadonlySet<Stock> = new Set(["IN_STOCK", "LIMITED"]);

export function deliveredOf(
  ctx: Pick<CheckContext, "sellingPricePaise" | "shippingPaise">,
): number {
  return ctx.sellingPricePaise + (ctx.shippingPaise ?? 0);
}

const shippingNote = (ctx: CheckContext) =>
  ctx.shippingPaise === null ? " (shipping not stated)" : "";

export function evaluateAlert(alert: AlertState, ctx: CheckContext): Decision {
  const price = deliveredOf(ctx);
  const at = `${formatPaise(price)}${shippingNote(ctx)} on ${ctx.marketplace}`;
  const base = { deliveredPaise: price };
  const notMet = (reason: string, extra: Partial<Decision> = {}): Decision => ({
    ...base,
    outcome: "NOT_MET",
    reason,
    ...extra,
  });
  const further = (p: number) =>
    alert.lastTriggeredPricePaise === null || p < alert.lastTriggeredPricePaise;
  const already = () =>
    notMet(
      `Already notified at ${formatPaise(alert.lastTriggeredPricePaise ?? 0)}; notifies again only if the price falls further.`,
    );

  switch (alert.type) {
    case "BACK_IN_STOCK": {
      const wasUnavailable = ctx.outcome === "REAPPEARED" || ctx.previousStock === "OUT_OF_STOCK";
      if (wasUnavailable && AVAILABLE.has(ctx.stock))
        return {
          ...base,
          outcome: "TRIGGERED",
          reason: `Available again on ${ctx.marketplace}.`,
          notification: {
            kind: "BACK_IN_STOCK",
            title: `${ctx.productName} is back in stock`,
            body: `Available again at ${at}. Stock and prices can change quickly; check before buying.`,
          },
        };
      return notMet(AVAILABLE.has(ctx.stock) ? "Was already available." : "Still not available.");
    }
    case "PRICE_CHANGE":
    case "PRICE_DROP": {
      const dropOnly = alert.type === "PRICE_DROP";
      if (ctx.outcome !== "PRICE_DECREASED" && (dropOnly || ctx.outcome !== "PRICE_INCREASED"))
        return notMet(
          dropOnly ? "No price decrease in this check." : "No price change in this check.",
        );
      const prev = ctx.previousPricePaise!;
      const diff = ctx.sellingPricePaise - prev;
      const bp = signedRatioBp(BigInt(diff), BigInt(prev));
      const dir = diff < 0 ? "decreased" : "increased";
      const min = alert.minChangePaise ?? null;
      if (min !== null && Math.abs(diff) < min)
        return notMet(
          `Price ${dir} by ${formatPaise(Math.abs(diff))}, less than the ${formatPaise(min)} you asked for.`,
        );
      if (dropOnly && !AVAILABLE.has(ctx.stock))
        return notMet(`Price dropped, but it is not available on ${ctx.marketplace}.`);
      return {
        ...base,
        outcome: "TRIGGERED",
        reason: `Price ${dir} by ${formatPaise(Math.abs(diff))} (${formatBasisPoints(Math.abs(bp))}).`,
        notification: {
          kind: dropOnly ? "PRICE_DROP" : "PRICE_CHANGED",
          title: `${ctx.productName}: price ${dir} on ${ctx.marketplace}`,
          body: `The selling price ${dir} from ${formatPaise(prev)} to ${formatPaise(ctx.sellingPricePaise)} (${formatBasisPoints(Math.abs(bp))}) since the previous observation.`,
        },
      };
    }
  }

  // Level conditions need a price the user could actually pay now.
  if (!AVAILABLE.has(ctx.stock))
    return notMet(
      `Not available on ${ctx.marketplace} (${ctx.stock.toLowerCase().replace("_", " ")}).`,
    );

  switch (alert.type) {
    case "TARGET_PRICE":
    case "PRICE_BELOW": {
      const target = alert.targetPricePaise!;
      const met = alert.type === "TARGET_PRICE" ? price <= target : price < target;
      if (!met)
        return notMet(`${formatPaise(price)} is above the target of ${formatPaise(target)}.`, {
          rearm: alert.lastTriggeredPricePaise !== null,
        });
      if (!further(price)) return already();
      return {
        ...base,
        outcome: "TRIGGERED",
        reason: `${formatPaise(price)} is ${alert.type === "TARGET_PRICE" ? "at or below" : "below"} the target of ${formatPaise(target)}.`,
        notification: {
          kind: "TARGET_PRICE_REACHED",
          title: `Price alert: ${ctx.productName} is ${formatPaise(price)}`,
          body: `Delivered price is ${at}, ${alert.type === "TARGET_PRICE" ? "at or below" : "below"} your target of ${formatPaise(target)}. Prices can change; check before buying.`,
        },
      };
    }
    case "PERCENT_DROP": {
      const baseline = alert.baselinePricePaise;
      if (baseline === null)
        return {
          ...base,
          outcome: "INSUFFICIENT_DATA",
          reason: `Baseline recorded at ${formatPaise(price)}; drops are measured from it.`,
          setBaselinePaise: price,
        };
      const dropBp = signedRatioBp(BigInt(baseline - price), BigInt(baseline));
      const want = alert.dropPercentBp!;
      if (dropBp < want)
        return notMet(
          `Down ${formatBasisPoints(Math.max(0, dropBp))} from ${formatPaise(baseline)}; waiting for ${formatBasisPoints(want)}.`,
          { rearm: alert.lastTriggeredPricePaise !== null },
        );
      if (!further(price)) return already();
      return {
        ...base,
        outcome: "TRIGGERED",
        reason: `Down ${formatBasisPoints(dropBp)} from ${formatPaise(baseline)}.`,
        notification: {
          kind: "PRICE_DROP",
          title: `${ctx.productName} dropped ${formatBasisPoints(dropBp)}`,
          body: `Delivered price is ${at}, down ${formatBasisPoints(dropBp)} from ${formatPaise(baseline)} when your alert started.`,
        },
      };
    }
    case "HISTORICAL_LOW": {
      const days = alert.historicalWindowDays!;
      if (ctx.priorLowPaise === null)
        return {
          ...base,
          outcome: "INSUFFICIENT_DATA",
          reason: `Not enough price history in the last ${days} days (needs at least 3 earlier observations spanning 7 days).`,
        };
      if (price >= ctx.priorLowPaise)
        return notMet(
          `${formatPaise(price)} is not below the lowest observed ${formatPaise(ctx.priorLowPaise)} in the last ${days} days.`,
          { rearm: alert.lastTriggeredPricePaise !== null },
        );
      if (!further(price)) return already();
      return {
        ...base,
        outcome: "TRIGGERED",
        reason: `Below the lowest observed price of ${formatPaise(ctx.priorLowPaise)} in the last ${days} days.`,
        notification: {
          kind: "PRICE_DROP",
          title: `${ctx.productName}: lowest observed price in ${days} days`,
          body: `Delivered price is ${at}, below the lowest DealMind observed on this marketplace in the last ${days} days (${formatPaise(ctx.priorLowPaise)}). This is not an all-time claim.`,
        },
      };
    }
  }
}

/**
 * Lowest earlier delivered price in the window, or null when the history is
 * too thin to call anything a low: at least 3 earlier observations spanning
 * at least 7 days.
 */
export function priorLow(
  observations: { pricePaise: number; at: Date }[],
  minObservations = 3,
  minSpanDays = 7,
): number | null {
  if (observations.length < minObservations) return null;
  const times = observations.map((o) => o.at.getTime());
  if (Math.max(...times) - Math.min(...times) < minSpanDays * 86_400_000) return null;
  return Math.min(...observations.map((o) => o.pricePaise));
}
