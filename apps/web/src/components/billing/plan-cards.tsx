"use client";

/**
 * Plan comparison cards (pricing page and billing dashboard). Prices and
 * limits come from GET /billing/plans (integer paise); nothing is hardcoded.
 */
import type { BillingIntervalValue, PlanCode } from "@dealmind/shared";
import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/misc";
import { INTERVAL_LABEL, LIMIT_LABEL, annualSavingPercent } from "@/lib/billing";
import { rupees } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Plan } from "@/types/api";

const LIMIT_ORDER = [
  "searchesPerDay",
  "activeAlerts",
  "watchlists",
  "trackedProducts",
  "historyDays",
  "compareItems",
  "exportsPerMonth",
] as const;

export function IntervalToggle({
  value,
  onChange,
  plans,
}: {
  value: BillingIntervalValue;
  onChange: (v: BillingIntervalValue) => void;
  plans: Plan[];
}) {
  const best = Math.max(
    0,
    ...plans.map((p) => annualSavingPercent(p.monthlyPricePaise, p.annualPricePaise) ?? 0),
  );
  if (!plans.some((p) => p.annualPricePaise)) return null;
  return (
    <SegmentedControl
      label="Billing period"
      value={value}
      onChange={onChange}
      options={[
        { value: "MONTHLY", label: "Monthly" },
        { value: "ANNUAL", label: best ? `Annual (save up to ${best}%)` : "Annual" },
      ]}
    />
  );
}

export function PlanCards({
  plans,
  interval,
  currentPlan,
  action,
}: {
  plans: Plan[];
  interval: BillingIntervalValue;
  /** Highlights the caller's current plan. */
  currentPlan?: PlanCode | null;
  /** Renders the call to action for a plan. */
  action: (plan: Plan) => ReactNode;
}) {
  return (
    <ul className="grid gap-4 md:grid-cols-3">
      {plans.map((p) => {
        const annual = interval === "ANNUAL" && p.annualPricePaise !== null;
        const price = annual ? p.annualPricePaise! : p.monthlyPricePaise;
        const saving = annual ? annualSavingPercent(p.monthlyPricePaise, p.annualPricePaise) : null;
        return (
          <li
            key={p.code}
            aria-label={`${p.name} plan`}
            className={cn(
              "flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-(--shadow-card)",
              currentPlan === p.code && "border-primary ring-1 ring-primary",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">{p.name}</h3>
              {currentPlan === p.code ? <Badge tone="success">Your plan</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">{p.description}</p>
            <p>
              <span className="text-3xl font-semibold tabular">
                {p.code === "FREE" ? "₹0" : rupees(price)}
              </span>
              {p.code !== "FREE" ? (
                <span className="text-sm text-muted-foreground">
                  {" "}
                  / {INTERVAL_LABEL[annual ? "ANNUAL" : "MONTHLY"]}
                </span>
              ) : null}
              {saving ? (
                <span className="ml-2 text-xs font-medium text-success">Save {saving}%</span>
              ) : null}
            </p>
            {p.code !== "FREE" && interval === "ANNUAL" && p.annualPricePaise === null ? (
              <p className="text-xs text-muted-foreground">Monthly billing only.</p>
            ) : null}
            <ul className="flex flex-col gap-1.5 text-sm">
              {LIMIT_ORDER.map((k) => {
                const n = p.limits[k];
                const off = k === "exportsPerMonth" && n === 0;
                return (
                  <li key={k} className={cn("flex gap-2", off && "text-muted-foreground")}>
                    {off ? (
                      <Minus aria-hidden className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                    )}
                    {LIMIT_LABEL[k]!(n)}
                  </li>
                );
              })}
              <li
                className={cn("flex gap-2", !p.features.prioritySearch && "text-muted-foreground")}
              >
                {p.features.prioritySearch ? (
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <Minus aria-hidden className="mt-0.5 size-4 shrink-0" />
                )}
                {p.features.prioritySearch ? "Priority search processing" : "Standard search queue"}
              </li>
            </ul>
            <div className="mt-auto">{action(p)}</div>
          </li>
        );
      })}
    </ul>
  );
}

/** Taxes note shown next to prices. */
export const PRICE_NOTE =
  "Prices in Indian rupees. Applicable taxes (GST) are shown on your invoice. Payments are processed by EasyDev's payment service through Razorpay.";
