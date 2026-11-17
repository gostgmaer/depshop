/** Billing display helpers (prices come from the API in integer paise). */
import type { BillingIntervalValue, SubscriptionStatusValue } from "@dealmind/shared";
import type { Usage } from "@/types/api";

export type UsageKey = Usage["items"][number]["key"];

/** One usage item (0/0 while loading or when absent). */
export function usageOf(usage: Usage | undefined, key: UsageKey) {
  const item = usage?.items?.find((i) => i.key === key);
  return { used: item?.used ?? 0, limit: item?.limit ?? 0, resetsAt: item?.resetsAt ?? null };
}

export const INTERVAL_LABEL: Record<BillingIntervalValue, string> = {
  MONTHLY: "month",
  ANNUAL: "year",
};

export const STATUS_LABEL: Record<
  SubscriptionStatusValue,
  { label: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  TRIALING: { label: "Trial", tone: "success" },
  ACTIVE: { label: "Active", tone: "success" },
  PAST_DUE: { label: "Payment failed", tone: "warning" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  EXPIRED: { label: "Ended", tone: "neutral" },
  PAUSED: { label: "Paused", tone: "neutral" },
};

/** Annual saving vs. paying monthly for a year, in whole percent (integer math). */
export function annualSavingPercent(
  monthlyPaise: number,
  annualPaise: number | null,
): number | null {
  if (!annualPaise || monthlyPaise <= 0) return null;
  const year = monthlyPaise * 12;
  if (annualPaise >= year) return null;
  return Math.floor(((year - annualPaise) * 100) / year);
}

/** Labels for numeric limits (0 = unlimited for history, "not included" for exports). */
export const LIMIT_LABEL: Record<string, (n: number) => string> = {
  searchesPerDay: (n) => `${n.toLocaleString("en-IN")} AI searches a day`,
  activeAlerts: (n) => `${n.toLocaleString("en-IN")} active price alerts`,
  watchlists: (n) => `${n.toLocaleString("en-IN")} watchlists`,
  trackedProducts: (n) => `${n.toLocaleString("en-IN")} tracked products`,
  historyDays: (n) => (n === 0 ? "Full price history" : `${n} days of price history`),
  compareItems: (n) => `Compare ${n} products side by side`,
  exportsPerMonth: (n) =>
    n === 0 ? "No exports" : `${n.toLocaleString("en-IN")} CSV exports a month`,
};
