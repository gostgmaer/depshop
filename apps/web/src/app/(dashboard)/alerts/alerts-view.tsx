"use client";

import { BellRing, Info, Pause, Play, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader, SegmentedControl } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useAlertEvaluations, useAlertMutations, useAlerts, useUsage } from "@/hooks/queries";
import { TRACKING_EXPLAINER, describeAlert } from "@/lib/alerts";
import { formatDateTime, relativeTime, rupees, variantSummary } from "@/lib/format";

type Status = "ACTIVE" | "TRIGGERED" | "PAUSED" | "ALL";

export function AlertsView() {
  const [tab, setTab] = useState<Status>("ALL");
  const q = useAlerts(tab === "ALL" ? undefined : tab);
  const usage = useUsage();
  const m = useAlertMutations();
  return (
    <>
      <PageHeader
        title="Price alerts"
        description={
          usage.data
            ? `${usage.data.activeAlerts.used} of ${usage.data.activeAlerts.limit} active alerts on your plan.`
            : "Get notified when a product reaches your target price."
        }
      />
      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        {TRACKING_EXPLAINER}
      </p>
      <SegmentedControl
        label="Filter alerts by status"
        value={tab}
        onChange={setTab}
        options={(["ALL", "ACTIVE", "TRIGGERED", "PAUSED"] as const).map((s) => ({
          value: s,
          label: s === "ALL" ? "All" : s[0] + s.slice(1).toLowerCase(),
        }))}
      />
      {q.isPending ? (
        <LoadingRows rows={3} label="Loading alerts" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load alerts." onRetry={() => void q.refetch()} />
      ) : q.data.items.length ? (
        <ul className="flex flex-col gap-3">
          {q.data.items.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-card)"
            >
              <BellRing
                aria-hidden
                className={
                  a.status === "ACTIVE" ? "size-5 text-accent" : "size-5 text-muted-foreground"
                }
              />
              <div className="min-w-0 flex-1">
                <Link
                  href={`/products/${a.product.id}?variant=${a.variant.id}`}
                  className="font-medium hover:underline"
                >
                  {a.product.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {variantSummary(a.variant.attributes).join(" · ")} ·{" "}
                  {a.source ? a.source.name : "any marketplace"} · created{" "}
                  {relativeTime(a.createdAt)}
                </p>
                {a.lastTriggeredAt ? (
                  <p className="mt-1 text-xs text-primary">
                    Triggered {relativeTime(a.lastTriggeredAt)} at{" "}
                    {rupees(a.lastTriggeredPricePaise)}
                  </p>
                ) : null}
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Notify when</p>
                <p className="font-semibold">{describeAlert(a)}</p>
                {a.lastEvaluatedAt ? (
                  <p className="text-[11px] text-muted-foreground">
                    Last checked {relativeTime(a.lastEvaluatedAt)}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Not checked yet</p>
                )}
              </div>
              <Badge
                tone={
                  a.status === "ACTIVE" ? "ai" : a.status === "TRIGGERED" ? "success" : "neutral"
                }
              >
                {a.status.toLowerCase()}
              </Badge>
              <div className="flex gap-1">
                {a.status === "PAUSED" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Resume alert"
                    onClick={() => m.resume.mutate(a.id)}
                  >
                    <Play aria-hidden className="size-4" />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Pause alert"
                    onClick={() => m.pause.mutate(a.id)}
                  >
                    <Pause aria-hidden className="size-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete alert"
                  onClick={() => m.remove.mutate(a.id)}
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </div>
              <AlertHistory alertId={a.id} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={BellRing}
          title="No alerts here"
          description="Create an alert from a product page or search result."
        />
      )}
    </>
  );
}

/** The alert's evaluation history (each global price check it was checked against). */
function AlertHistory({ alertId }: { alertId: string }) {
  const [open, setOpen] = useState(false);
  const q = useAlertEvaluations(alertId, open);
  return (
    <details className="w-full text-xs" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-medium text-accent">History</summary>
      {q.isPending ? (
        <p className="mt-2 text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p className="mt-2 text-danger">Couldn't load the history.</p>
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
          Not evaluated yet: it is checked after the next price check of this product.
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
