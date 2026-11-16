"use client";

/**
 * Price tracking for one variant: watch it, create an alert with a target
 * price and an optional preferred marketplace, and see your own tracking
 * history (the API scopes both lists to the signed-in user).
 */
import { Bell, Star } from "lucide-react";
import Link from "next/link";
import { AlertEditDialog, PriceAlertDialog } from "@/components/alerts/price-alert-form";
import { WatchlistButton } from "@/components/products/watchlist-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useVariantTracking } from "@/hooks/queries";
import { ALERT_STATUS_LABEL, TRACKING_EXPLAINER, describeAlert } from "@/lib/alerts";
import { formatDate } from "@/lib/format";

export function TrackingPanel({
  variantId,
  variantLabel,
  currentPricePaise,
  sources,
}: {
  variantId: string;
  variantLabel: string;
  currentPricePaise: number | null;
  sources: { id: string; name: string }[];
}) {
  const t = useVariantTracking(variantId);
  const alerts = t.alerts.data?.items ?? [];
  const lists = t.watchlists.data?.items ?? [];
  return (
    <Card>
      <CardHeader
        title="Track this price"
        description={`For ${variantLabel || "this variant"}. Set a target price and, optionally, the one marketplace to watch.`}
      />
      <div className="flex flex-wrap gap-2">
        <WatchlistButton variantId={variantId} size="default" />
        <PriceAlertDialog
          variantId={variantId}
          currentPricePaise={currentPricePaise}
          sources={sources}
          size="default"
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{TRACKING_EXPLAINER}</p>
      <section aria-labelledby="tracking-history" className="mt-4 flex flex-col gap-2">
        <h3 id="tracking-history" className="text-sm font-semibold">
          Your tracking history
        </h3>
        {t.alerts.isPending || t.watchlists.isPending ? (
          <LoadingRows rows={2} label="Loading your tracking" />
        ) : t.alerts.isError || t.watchlists.isError ? (
          <ErrorState
            message="Couldn't load your tracking history."
            onRetry={() => {
              void t.alerts.refetch();
              void t.watchlists.refetch();
            }}
          />
        ) : !alerts.length && !lists.length ? (
          <p className="text-xs text-muted-foreground">
            You aren&apos;t tracking this variant yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {lists.map((w) => (
              <li key={w.id} className="flex items-center gap-2">
                <Star aria-hidden className="size-4 text-warning" />
                In watchlist{" "}
                <Link href={`/watchlists/${w.id}`} className="font-medium hover:underline">
                  {w.name}
                </Link>
              </li>
            ))}
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <Bell aria-hidden className="size-4 text-accent" />
                <span className="font-medium">{describeAlert(a)}</span>
                {a.source ? `on ${a.source.name}` : "on any marketplace"}
                <Badge tone={ALERT_STATUS_LABEL[a.status].tone}>
                  {ALERT_STATUS_LABEL[a.status].label}
                </Badge>
                {a.status === "ACTIVE" || a.status === "PAUSED" || a.status === "TRIGGERED" ? (
                  <AlertEditDialog alert={a} sources={sources} />
                ) : null}
                <span className="text-xs text-muted-foreground">
                  created {formatDate(a.createdAt)}
                  {a.lastTriggeredAt ? ` · last triggered ${formatDate(a.lastTriggeredAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {alerts.length || lists.length ? (
          <Link href="/alerts" className="text-xs text-accent hover:underline">
            Manage all alerts
          </Link>
        ) : null}
      </section>
    </Card>
  );
}
