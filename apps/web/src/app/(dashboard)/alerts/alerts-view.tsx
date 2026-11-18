"use client";

import { usageOf } from "@/lib/billing";
import type { AlertStatusValue } from "@dealmind/shared";
import { Ban, BellRing, Info, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AlertEditDialog } from "@/components/alerts/price-alert-form";
import { ProductImage } from "@/components/products/product-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader, SegmentedControl } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/primitives";
import { LoadingRows } from "@/components/ui/skeleton";
import { useAlertEvaluations, useAlertMutations, useAlerts, useUsage } from "@/hooks/queries";
import { ALERT_STATUS_LABEL, TRACKING_EXPLAINER, describeAlert, isTargetAlert } from "@/lib/alerts";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDate, formatDateTime, relativeTime, rupees, variantSummary } from "@/lib/format";
import type { PriceAlert } from "@/types/api";

type Tab = AlertStatusValue | "ALL";
const TABS: { value: Tab; label: string }[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
  { value: "TRIGGERED", label: "Triggered" },
  { value: "EXPIRED", label: "Ended" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "ALL", label: "All" },
];

export function AlertsView() {
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const q = useAlerts(tab === "ALL" ? undefined : tab);
  const usage = useUsage();
  const m = useAlertMutations();
  const [toDelete, setToDelete] = useState<PriceAlert | null>(null);
  const failed = [m.pause, m.resume, m.cancel, m.remove].find((x) => x.isError);
  return (
    <>
      <PageHeader
        title="Price alerts"
        description={
          usage.data
            ? `${usageOf(usage.data, "activeAlerts").used} of ${usageOf(usage.data, "activeAlerts").limit} active alerts on your plan.`
            : "Get notified when a product meets your condition."
        }
      />
      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        {TRACKING_EXPLAINER}
      </p>
      <div className="relative overflow-x-auto">
        <SegmentedControl
          label="Filter alerts by status"
          value={tab}
          onChange={setTab}
          options={TABS}
        />
      </div>
      {failed ? <ErrorState message={errorMessage(failed.error)} /> : null}
      {q.isPending ? (
        <LoadingRows rows={3} label="Loading alerts" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load alerts." onRetry={() => void q.refetch()} />
      ) : q.data.items.length ? (
        <ul className="flex flex-col gap-3">
          {q.data.items.map((a) => (
            <li key={a.id}>
              <AlertCard alert={a} onDelete={() => setToDelete(a)} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={BellRing}
          title={
            tab === "ALL"
              ? "No alerts yet"
              : `No ${TABS.find((t) => t.value === tab)?.label.toLowerCase()} alerts`
          }
          description="Create an alert from a product page, a search result or a watchlist."
        />
      )}
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => {
          if (!o) setToDelete(null);
        }}
        title={`Delete the alert for ${toDelete?.product.name ?? ""}?`}
        description="The alert and its history are removed. To stop it but keep the history, cancel it instead."
        confirmLabel="Delete alert"
        pending={m.remove.isPending}
        onConfirm={() => {
          if (!toDelete) return;
          m.remove.mutate(toDelete.id, { onSettled: () => setToDelete(null) });
        }}
      />
    </>
  );
}

function AlertCard({ alert: a, onDelete }: { alert: PriceAlert; onDelete: () => void }) {
  const m = useAlertMutations();
  const st = ALERT_STATUS_LABEL[a.status];
  const live = a.status === "ACTIVE" || a.status === "PAUSED" || a.status === "TRIGGERED";
  return (
    <article
      aria-label={`Alert for ${a.product.name}`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-card)"
    >
      <div className="flex flex-wrap items-start gap-4">
        <ProductImage src={a.product.imageUrl} alt="" size={48} />
        <div className="min-w-0 flex-1">
          <Link
            href={`/products/${a.product.id}?variant=${a.variant.id}`}
            className="font-medium hover:underline"
          >
            {a.product.name}
          </Link>
          <p className="text-xs text-muted-foreground">
            {variantSummary(a.variant.attributes).join(" · ")} ·{" "}
            {a.source ? a.source.name : "any marketplace"}
          </p>
          <p className="mt-1 text-sm font-semibold">{describeAlert(a)}</p>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
        <div className="flex gap-1">
          {a.status === "ACTIVE" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Pause alert"
              onClick={() => m.pause.mutate(a.id)}
            >
              <Pause aria-hidden className="size-4" />
            </Button>
          ) : a.status === "PAUSED" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Resume alert"
              onClick={() => m.resume.mutate(a.id)}
            >
              <Play aria-hidden className="size-4" />
            </Button>
          ) : a.status === "TRIGGERED" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Turn alert back on"
              onClick={() => m.resume.mutate(a.id)}
            >
              <RotateCcw aria-hidden className="size-4" />
            </Button>
          ) : null}
          {live ? <AlertEditDialog alert={a} /> : null}
          {live ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cancel alert"
              onClick={() => m.cancel.mutate(a.id)}
            >
              <Ban aria-hidden className="size-4" />
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" aria-label="Delete alert" onClick={onDelete}>
            <Trash2 aria-hidden className="size-4" />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">Current price</p>
          {a.current ? (
            <p>
              <span className="font-semibold tabular">{rupees(a.current.deliveredPaise)}</span>{" "}
              <span className="text-xs text-muted-foreground">
                on {a.current.marketplace.name} · {relativeTime(a.current.observedAt)}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">No current offer</p>
          )}
        </div>
        {isTargetAlert(a.type) ? <Progress alert={a} /> : <div />}
        <div className="text-xs text-muted-foreground">
          <p>
            {a.channels
              .map((c) => (c === "IN_APP" ? "In-app" : c === "EMAIL" ? "Email" : "Browser"))
              .join(" + ")}{" "}
            · {a.repeat ? "keeps watching" : "stops once met"}
            {a.cooldownMinutes
              ? ` · at most every ${a.cooldownMinutes >= 1440 ? `${a.cooldownMinutes / 1440} day(s)` : `${a.cooldownMinutes / 60} h`}`
              : ""}
          </p>
          <p>
            {a.expiresAt ? `Ends ${formatDate(a.expiresAt)}` : "No end date"} ·{" "}
            {a.triggerCount
              ? `triggered ${a.triggerCount}×, last ${relativeTime(a.lastTriggeredAt)}`
              : "not triggered yet"}
          </p>
          <p>
            {a.lastEvaluatedAt
              ? `Last checked ${relativeTime(a.lastEvaluatedAt)}`
              : "Not checked yet"}
          </p>
        </div>
      </div>
      <AlertHistory alertId={a.id} />
    </article>
  );
}

/** Progress from the price when the alert started toward its target. */
function Progress({ alert: a }: { alert: PriceAlert }) {
  if (a.progressBp === null)
    return (
      <p className="text-xs text-muted-foreground">
        Progress appears once there is a current price and a start price.
      </p>
    );
  const pct = Math.floor(a.progressBp / 100);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">Toward your target</p>
      <div
        role="progressbar"
        aria-label={`Progress toward ${rupees(a.targetPricePaise)}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={
          pct >= 100
            ? "Target reached"
            : `${pct}% of the way from ${rupees(a.baselinePricePaise)} to ${rupees(a.targetPricePaise)}`
        }
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground tabular">
        {pct >= 100
          ? "Target reached"
          : `${pct}% of the way: ${rupees(a.baselinePricePaise)} → ${rupees(a.targetPricePaise)}`}
      </p>
    </div>
  );
}

/** The alert's evaluation history; "Previous triggers" filters to notifications sent. */
function AlertHistory({ alertId }: { alertId: string }) {
  const [open, setOpen] = useState(false);
  const [triggersOnly, setTriggersOnly] = useState(false);
  const q = useAlertEvaluations(alertId, open, triggersOnly);
  return (
    <details className="w-full text-xs" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-medium text-accent">History</summary>
      <div className="mt-2">
        <SegmentedControl
          label="History filter"
          value={triggersOnly ? "t" : "a"}
          onChange={(v) => setTriggersOnly(v === "t")}
          options={[
            { value: "a", label: "All checks" },
            { value: "t", label: "Previous triggers" },
          ]}
        />
      </div>
      {q.isPending ? (
        <p className="mt-2 text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p className="mt-2 text-danger">Couldn&apos;t load the history.</p>
      ) : q.data.items.length ? (
        <ul className="mt-2 flex flex-col gap-1">
          {q.data.items.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-0.5">
              <span className="text-muted-foreground">{formatDateTime(e.evaluatedAt)}</span>
              <span className="font-medium">{EVALUATION_LABEL[e.outcome]}</span>
              <span>
                {e.observedPricePaise !== null ? `${rupees(e.observedPricePaise)} on ` : ""}
                {e.marketplace.name}
              </span>
              <span className="w-full text-muted-foreground">{e.reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-muted-foreground">
          {triggersOnly
            ? "This alert hasn't notified you yet."
            : "Not evaluated yet: it is checked after the next price check of this product."}
        </p>
      )}
    </details>
  );
}

const EVALUATION_LABEL: Record<string, string> = {
  TRIGGERED: "Notified",
  NOT_MET: "Not met",
  COOLDOWN: "Met (within cooldown, not re-sent)",
  SUPPRESSED: "Met (notifications off)",
  INSUFFICIENT_DATA: "Not enough data",
};
