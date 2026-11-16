/**
 * Default plan catalogue (Phase 6.1). This is the seed and the fallback: the
 * live values are the admin-editable `SubscriptionPlan` rows, so prices and
 * limits are configured in one place rather than spread through the code.
 *
 * Prices are DealMind's own configurable list prices in integer paise (INR),
 * not marketplace data. Features list only what the product actually
 * enforces or provides.
 */
import type { PlanCode } from "./schemas.js";

/** Numeric limits, enforced server-side by the entitlement service. */
export interface PlanLimits {
  /** AI shopping searches per day (IST calendar day). */
  searchesPerDay: number;
  /** Active price alerts at any time. */
  activeAlerts: number;
  /** Watchlists at any time. */
  watchlists: number;
  /** Products (variants) across all watchlists: bulk tracking. */
  trackedProducts: number;
  /** Days of price history shown; 0 = everything stored. */
  historyDays: number;
  /** Products compared side by side. */
  compareItems: number;
  /** Data exports per month (IST calendar month); 0 = not included. */
  exportsPerMonth: number;
}

export const PLAN_LIMIT_KEYS = [
  "searchesPerDay",
  "activeAlerts",
  "watchlists",
  "trackedProducts",
  "historyDays",
  "compareItems",
  "exportsPerMonth",
] as const satisfies readonly (keyof PlanLimits)[];

/** On/off features, enforced server-side. */
export interface PlanFeatures {
  /** Searches are queued ahead of free searches. */
  prioritySearch: boolean;
  /** CSV export of the user's own watchlists, alerts and search history. */
  exports: boolean;
}

export const PLAN_FEATURE_KEYS = [
  "prioritySearch",
  "exports",
] as const satisfies readonly (keyof PlanFeatures)[];

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  description: string;
  monthlyPricePaise: number;
  /** Null when the plan has no annual option. */
  annualPricePaise: number | null;
  limits: PlanLimits;
  features: PlanFeatures;
  sortOrder: number;
}

export const DEFAULT_PLANS: Record<PlanCode, PlanDefinition> = {
  FREE: {
    code: "FREE",
    name: "Free",
    description: "Compare prices and track a few products.",
    monthlyPricePaise: 0,
    annualPricePaise: null,
    limits: {
      searchesPerDay: 20,
      activeAlerts: 5,
      watchlists: 2,
      trackedProducts: 25,
      historyDays: 90,
      compareItems: 2,
      exportsPerMonth: 0,
    },
    features: { prioritySearch: false, exports: false },
    sortOrder: 0,
  },
  PRO: {
    code: "PRO",
    name: "Pro",
    description: "For regular shoppers who want more searches, alerts and history.",
    monthlyPricePaise: 19_900,
    annualPricePaise: 1_99_000,
    limits: {
      searchesPerDay: 200,
      activeAlerts: 100,
      watchlists: 20,
      trackedProducts: 500,
      historyDays: 365,
      compareItems: 4,
      exportsPerMonth: 10,
    },
    features: { prioritySearch: true, exports: true },
    sortOrder: 1,
  },
  BUSINESS: {
    code: "BUSINESS",
    name: "Business",
    description: "High limits and bulk tracking for heavy research.",
    monthlyPricePaise: 99_900,
    annualPricePaise: 9_99_000,
    limits: {
      searchesPerDay: 2_000,
      activeAlerts: 1_000,
      watchlists: 200,
      trackedProducts: 10_000,
      historyDays: 0,
      compareItems: 4,
      exportsPerMonth: 200,
    },
    features: { prioritySearch: true, exports: true },
    sortOrder: 2,
  },
};
