/**
 * Plan catalogue: the admin-editable SubscriptionPlan rows, read defensively.
 * Each limit/feature falls back to the default catalogue when a row is
 * missing it or holds an invalid value, so a bad edit can't remove a limit.
 */
import {
  type BillingIntervalValue,
  DEFAULT_PLANS,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  type PlanCode,
  type PlanDefinition,
  type PlanFeatures,
  type PlanLimits,
  type PlanView,
} from "@dealmind/shared";

export interface PlanRow {
  code: PlanCode;
  name: string;
  description: string;
  monthlyPricePaise: bigint;
  annualPricePaise: bigint | null;
  limits: unknown;
  features: unknown;
  sortOrder: number;
  providerPlanIds: unknown;
  active: boolean;
}

export interface Plan extends PlanDefinition {
  /** Provider plan id per interval (shared payment service), when provisioned. */
  providerPlanIds: Partial<Record<BillingIntervalValue, string>>;
  active: boolean;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function planFromRow(row: PlanRow): Plan {
  const d = DEFAULT_PLANS[row.code];
  const lim = obj(row.limits);
  const feat = obj(row.features);
  const limits = {} as PlanLimits;
  for (const k of PLAN_LIMIT_KEYS) {
    const v = lim[k];
    limits[k] = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : d.limits[k];
  }
  const features = {} as PlanFeatures;
  for (const k of PLAN_FEATURE_KEYS) {
    const v = feat[k];
    features[k] = typeof v === "boolean" ? v : d.features[k];
  }
  const ids = obj(row.providerPlanIds);
  const providerPlanIds: Plan["providerPlanIds"] = {};
  for (const i of ["MONTHLY", "ANNUAL"] as const)
    if (typeof ids[i] === "string" && ids[i]) providerPlanIds[i] = ids[i];
  return {
    code: row.code,
    name: row.name,
    description: row.description || d.description,
    monthlyPricePaise: Number(row.monthlyPricePaise),
    annualPricePaise: row.annualPricePaise === null ? null : Number(row.annualPricePaise),
    limits,
    features,
    sortOrder: row.sortOrder,
    providerPlanIds,
    active: row.active,
  };
}

export const defaultPlan = (code: PlanCode): Plan => ({
  ...DEFAULT_PLANS[code],
  providerPlanIds: {},
  active: true,
});

/** Price of one interval, or null when that interval isn't offered. */
export function priceOf(plan: Plan, interval: BillingIntervalValue): number | null {
  if (plan.code === "FREE") return null;
  return interval === "MONTHLY" ? plan.monthlyPricePaise : plan.annualPricePaise;
}

/** Intervals that can be bought now: priced, provisioned with the provider, and active. */
export function purchasableIntervals(plan: Plan, providerReady: boolean): BillingIntervalValue[] {
  if (plan.code === "FREE" || !plan.active) return [];
  return (["MONTHLY", "ANNUAL"] as const).filter((i) => {
    const price = priceOf(plan, i);
    return price !== null && price > 0 && (providerReady || Boolean(plan.providerPlanIds[i]));
  });
}

export function planView(plan: Plan, providerReady: boolean): PlanView {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    monthlyPricePaise: plan.monthlyPricePaise,
    annualPricePaise: plan.annualPricePaise,
    limits: { ...plan.limits },
    features: { ...plan.features },
    purchasableIntervals: purchasableIntervals(plan, providerReady),
  };
}
