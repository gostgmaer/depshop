"use client";

import { Check, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ErrorState, PageHeader } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { usePlans, useSubscription, useUsage } from "@/hooks/queries";
import { formatDate, rupees } from "@/lib/format";
import { cn } from "@/lib/utils";

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular text-muted-foreground">
          {used} / {limit}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", pct >= 90 ? "bg-warning" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function BillingView() {
  const plans = usePlans();
  const sub = useSubscription();
  const usage = useUsage();
  return (
    <>
      <PageHeader title="Subscription" description="Your plan and usage." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Current plan" />
          {sub.isPending ? (
            <LoadingRows rows={2} />
          ) : sub.isError ? (
            <ErrorState
              message="Couldn't load your subscription."
              onRetry={() => void sub.refetch()}
            />
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <p className="flex items-center gap-2 text-xl font-semibold">
                {sub.data.plan.name}
                <Badge tone={sub.data.status === "ACTIVE" ? "success" : "warning"}>
                  {sub.data.status.toLowerCase().replace("_", " ")}
                </Badge>
              </p>
              <p className="text-muted-foreground">
                {sub.data.plan.monthlyPricePaise
                  ? `${rupees(sub.data.plan.monthlyPricePaise)} / month`
                  : "Free"}
                {sub.data.currentPeriodEnd
                  ? ` · renews ${formatDate(sub.data.currentPeriodEnd)}`
                  : ""}
              </p>
              {sub.data.cancelAtPeriodEnd ? (
                <p className="text-warning">Cancels at the end of the period.</p>
              ) : null}
            </div>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Usage" />
          {usage.isPending ? (
            <LoadingRows rows={3} />
          ) : usage.isError ? (
            <ErrorState message="Couldn't load usage." onRetry={() => void usage.refetch()} />
          ) : (
            <div className="flex flex-col gap-4">
              <Meter
                label="Searches today"
                used={usage.data.searchesToday.used}
                limit={usage.data.searchesToday.limit}
              />
              <Meter
                label="Active price alerts"
                used={usage.data.activeAlerts.used}
                limit={usage.data.activeAlerts.limit}
              />
              <Meter
                label="Watchlists"
                used={usage.data.watchlists.used}
                limit={usage.data.watchlists.limit}
              />
              <p className="text-xs text-muted-foreground">
                Daily searches reset {formatDate(usage.data.searchesToday.resetsAt)}.
              </p>
            </div>
          )}
        </Card>
      </div>
      <section aria-labelledby="plans" className="flex flex-col gap-3">
        <h2 id="plans" className="text-lg font-semibold">
          Plans
        </h2>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          Online payments aren't available yet, so plans can't be changed from here.
        </p>
        {plans.isPending ? (
          <LoadingRows rows={2} />
        ) : plans.isError ? (
          <ErrorState message="Couldn't load plans." onRetry={() => void plans.refetch()} />
        ) : (
          <ul className="grid gap-4 md:grid-cols-3">
            {plans.data.map((p) => {
              const current = sub.data?.plan.code === p.code;
              return (
                <li
                  key={p.code}
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border bg-surface p-5 shadow-(--shadow-card)",
                    current ? "border-primary/50" : "border-border",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">{p.name}</p>
                    {current ? <Badge tone="success">Current</Badge> : null}
                  </div>
                  <p className="text-2xl font-semibold tabular">
                    {p.monthlyPricePaise ? rupees(p.monthlyPricePaise) : "Free"}
                    {p.monthlyPricePaise ? (
                      <span className="text-sm font-normal text-muted-foreground"> / month</span>
                    ) : null}
                  </p>
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {[
                      `${p.limits.searchesPerDay} searches per day`,
                      `${p.limits.activeAlerts} active price alerts`,
                      `${p.limits.watchlists} watchlists`,
                    ].map((f) => (
                      <li key={f} className="flex items-center gap-2">
                        <Check aria-hidden className="size-4 text-primary" /> {f}
                      </li>
                    ))}
                  </ul>
                  <Button variant={current ? "secondary" : "outline"} disabled className="mt-auto">
                    {current ? "Your plan" : "Upgrade unavailable"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
