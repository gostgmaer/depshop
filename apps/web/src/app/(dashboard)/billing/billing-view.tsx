"use client";

import type { BillingIntervalValue } from "@dealmind/shared";
import { AlertTriangle, Download, FlaskConical } from "lucide-react";
import { useState } from "react";
import { CheckoutDialog } from "@/components/billing/checkout-dialog";
import { IntervalToggle, PRICE_NOTE, PlanCards } from "@/components/billing/plan-cards";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ErrorState, PageHeader } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/primitives";
import { LoadingRows } from "@/components/ui/skeleton";
import {
  useBillingMutations,
  useInvoices,
  usePayments,
  usePlans,
  useSubscription,
  useUsage,
} from "@/hooks/queries";
import { errorMessage } from "@/lib/auth-hooks";
import { INTERVAL_LABEL, STATUS_LABEL } from "@/lib/billing";
import { formatDate, rupees } from "@/lib/format";
import { cn } from "@/lib/utils";
import { billing } from "@/services";
import type { Plan, Subscription } from "@/types/api";

function Meter({
  label,
  used,
  limit,
  note,
}: {
  label: string;
  used: number;
  limit: number;
  note?: string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div>
      <div className="flex justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="tabular text-muted-foreground">
          {limit === 0
            ? "Not included"
            : `${used.toLocaleString("en-IN")} / ${limit.toLocaleString("en-IN")}`}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            limit === 0 ? "bg-muted" : pct >= 90 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${limit === 0 ? 0 : pct}%` }}
        />
      </div>
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

const paidLive = (s: Subscription) =>
  s.plan.code !== "FREE" && ["ACTIVE", "TRIALING", "PAST_DUE", "PAUSED"].includes(s.status);

export function BillingView() {
  const plans = usePlans();
  const sub = useSubscription();
  const usage = useUsage();
  const m = useBillingMutations();
  const [interval, setInterval] = useState<BillingIntervalValue>("MONTHLY");
  const [buying, setBuying] = useState<Plan | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [change, setChange] = useState<Plan | null>(null);

  if (plans.isPending || sub.isPending) return <LoadingRows rows={4} label="Loading billing" />;
  if (plans.isError || sub.isError)
    return (
      <ErrorState
        message="Couldn't load your billing details."
        onRetry={() => {
          void plans.refetch();
          void sub.refetch();
        }}
      />
    );
  const s = sub.data;
  const live = paidLive(s);
  const st = STATUS_LABEL[s.status];
  const failed = m.cancel.error ?? m.changePlan.error;

  const action = (p: Plan) => {
    if (live && p.code === s.plan.code && s.interval === interval)
      return <p className="text-sm text-muted-foreground">Your current plan</p>;
    if (p.code === "FREE")
      return live && !s.cancelAtPeriodEnd ? (
        <Button variant="outline" className="w-full" onClick={() => setConfirmCancel(true)}>
          Downgrade to Free
        </Button>
      ) : s.effectivePlan === "FREE" ? (
        <p className="text-sm text-muted-foreground">Your current plan</p>
      ) : null;
    const buyable = p.purchasableIntervals.includes(interval);
    if (!buyable)
      return (
        <p className="text-sm text-muted-foreground">
          {plans.data.some((x) => x.purchasableIntervals.length)
            ? `Not available ${interval === "ANNUAL" ? "annually" : "monthly"}.`
            : "Payments aren't available yet."}
        </p>
      );
    if (live)
      return (
        <Button
          className="w-full"
          variant="outline"
          disabled={s.status === "PAST_DUE"}
          onClick={() => setChange(p)}
        >
          Switch to {p.name}
        </Button>
      );
    return (
      <Button className="w-full" onClick={() => setBuying(p)}>
        Upgrade to {p.name}
      </Button>
    );
  };

  return (
    <>
      <PageHeader title="Billing" description="Your plan, usage, payments and invoices." />
      {failed ? <Alert tone="error">{errorMessage(failed)}</Alert> : null}

      <Card>
        <CardHeader title="Current plan" />
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-xl font-semibold">{s.plan.name}</span>
            {s.plan.code !== "FREE" ? <Badge tone={st.tone}>{st.label}</Badge> : null}
            {s.interval ? (
              <span className="text-sm text-muted-foreground">
                billed {INTERVAL_LABEL[s.interval]}ly
              </span>
            ) : null}
            {s.provider === "sandbox" ? (
              <Badge tone="warning">
                <FlaskConical aria-hidden className="size-3" /> Sandbox (test mode)
              </Badge>
            ) : null}
          </p>
          {s.effectivePlan !== s.plan.code ? (
            <Alert tone="warning">
              Your {s.plan.name} features are paused; Free plan limits apply until the subscription
              is active again.
            </Alert>
          ) : null}
          {s.status === "PAST_DUE" && s.graceUntil ? (
            <Alert tone="warning">
              <AlertTriangle aria-hidden className="mr-1 inline size-4" />
              Your last payment failed. We&apos;ll retry it; your {s.plan.name} features stay on
              until {formatDate(s.graceUntil)}.
            </Alert>
          ) : null}
          {live && s.currentPeriodEnd ? (
            <p className="text-sm text-muted-foreground">
              {s.cancelAtPeriodEnd
                ? `Cancelled: your ${s.plan.name} plan ends on ${formatDate(s.currentPeriodEnd)} and won't renew.`
                : `Renews on ${formatDate(s.currentPeriodEnd)}.`}
            </p>
          ) : null}
          {live && !s.cancelAtPeriodEnd ? (
            <div>
              <Button
                variant="outline"
                onClick={() => setConfirmCancel(true)}
                disabled={m.cancel.isPending}
              >
                Cancel subscription
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Usage" description="Limits of the plan that applies right now." />
        {usage.isPending ? (
          <LoadingRows rows={3} label="Loading usage" />
        ) : usage.isError ? (
          <ErrorState message="Couldn't load usage." onRetry={() => void usage.refetch()} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {usage.data.items.map((i) => (
              <Meter
                key={i.key}
                label={i.label}
                used={i.used}
                limit={i.limit}
                {...(i.resetsAt ? { note: `Resets ${formatDate(i.resetsAt)}` } : {})}
              />
            ))}
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Price history:{" "}
              {usage.data.historyDays === 0
                ? "everything stored"
                : `last ${usage.data.historyDays} days`}{" "}
              · compare up to {usage.data.compareItems} products.
            </p>
          </div>
        )}
      </Card>

      <section aria-labelledby="plans-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="plans-heading" className="text-lg font-semibold">
            Plans
          </h2>
          <IntervalToggle value={interval} onChange={setInterval} plans={plans.data} />
        </div>
        <PlanCards
          plans={plans.data}
          interval={interval}
          currentPlan={s.effectivePlan}
          action={action}
        />
        <p className="text-xs text-muted-foreground">{PRICE_NOTE}</p>
      </section>

      {s.plan.code !== "FREE" || s.provider ? <History /> : null}
      {usage.data && usage.data.items.find((i) => i.key === "exports")?.limit ? <Exports /> : null}

      {buying && buying.code !== "FREE" ? (
        <CheckoutDialog
          plan={buying.code}
          interval={interval}
          planName={buying.name}
          open
          onOpenChange={(o) => {
            if (!o) {
              setBuying(null);
              m.refresh();
            }
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel your subscription?"
        description={
          s.currentPeriodEnd
            ? `You keep ${s.plan.name} until ${formatDate(s.currentPeriodEnd)}; it won't renew after that.`
            : "Your plan won't renew."
        }
        confirmLabel="Cancel subscription"
        pending={m.cancel.isPending}
        onConfirm={() => m.cancel.mutate(undefined, { onSettled: () => setConfirmCancel(false) })}
      />
      <ConfirmDialog
        open={change !== null}
        onOpenChange={(o) => {
          if (!o) setChange(null);
        }}
        title={`Switch to ${change?.name ?? ""}?`}
        description="The payment service applies the change to your subscription; the new price applies from your next billing period."
        confirmLabel={`Switch to ${change?.name ?? ""}`}
        pending={m.changePlan.isPending}
        onConfirm={() => {
          if (!change) return;
          m.changePlan.mutate(
            { plan: change.code, interval },
            { onSettled: () => setChange(null) },
          );
        }}
      />
    </>
  );
}

function History() {
  const payments = usePayments();
  const invoices = useInvoices();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Payments" />
        {payments.isPending ? (
          <LoadingRows rows={2} label="Loading payments" />
        ) : payments.isError ? (
          <ErrorState
            message={errorMessage(payments.error)}
            onRetry={() => void payments.refetch()}
          />
        ) : payments.data.length ? (
          <table className="w-full text-sm">
            <caption className="sr-only">Your DealMind payments</caption>
            <thead className="text-left text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 font-medium">
                  Date
                </th>
                <th scope="col" className="py-1 font-medium">
                  Description
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payments.data.map((p) => (
                <tr key={p.id}>
                  <td className="py-2">{formatDate(p.createdAt)}</td>
                  <td className="py-2">{p.description ?? "DealMind subscription"}</td>
                  <td className="py-2 text-right tabular">{rupees(p.amountPaise)}</td>
                  <td className="py-2 text-right">{p.status.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">No payments yet.</p>
        )}
      </Card>
      <Card>
        <CardHeader title="Invoices" />
        {invoices.isPending ? (
          <LoadingRows rows={2} label="Loading invoices" />
        ) : invoices.isError ? (
          <ErrorState
            message={errorMessage(invoices.error)}
            onRetry={() => void invoices.refetch()}
          />
        ) : invoices.data.length ? (
          <table className="w-full text-sm">
            <caption className="sr-only">Your DealMind invoices</caption>
            <thead className="text-left text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 font-medium">
                  Invoice
                </th>
                <th scope="col" className="py-1 font-medium">
                  Issued
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Tax
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {invoices.data.map((i) => (
                <tr key={i.id}>
                  <td className="py-2">
                    {i.invoiceNumber ?? i.id.slice(0, 8)}{" "}
                    <span className="text-xs text-muted-foreground">{i.status.toLowerCase()}</span>
                  </td>
                  <td className="py-2">{i.issuedAt ? formatDate(i.issuedAt) : "—"}</td>
                  <td className="py-2 text-right tabular">{rupees(i.taxPaise)}</td>
                  <td className="py-2 text-right tabular">{rupees(i.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        )}
      </Card>
    </div>
  );
}

function Exports() {
  return (
    <Card>
      <CardHeader
        title="Exports"
        description="Download your own data as CSV (counts toward your monthly exports)."
      />
      <div className="flex flex-wrap gap-2">
        {(["watchlists", "alerts", "searches"] as const).map((k) => (
          <Button key={k} variant="outline" asChild>
            <a href={billing.exportUrl(k)} download>
              <Download aria-hidden className="size-4" /> {k[0]!.toUpperCase() + k.slice(1)}
            </a>
          </Button>
        ))}
      </div>
    </Card>
  );
}
