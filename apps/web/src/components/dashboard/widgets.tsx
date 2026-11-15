"use client";

import { TERMINAL_SEARCH_STATUSES } from "@dealmind/shared";
import {
  BellRing,
  CheckCircle2,
  Clock,
  Flame,
  PiggyBank,
  Rocket,
  Search as SearchIcon,
  ShieldCheck,
  Star,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { DiscountIndicator } from "@/components/offers/pricing-parts";
import { ProductCard, ProductImage } from "@/components/products/product-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/misc";
import { LoadingRows, Skeleton } from "@/components/ui/skeleton";
import {
  useAlerts,
  useProducts,
  useSearchResults,
  useSearches,
  useSourceStatus,
  useUsage,
  useWatchlist,
  useWatchlists,
} from "@/hooks/queries";
import { useMe } from "@/lib/auth-hooks";
import { relativeTime, rupees } from "@/lib/format";
import type { Search } from "@/types/api";

export function Welcome() {
  const me = useMe();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {greeting}
        {me.data?.name ? `, ${me.data.name.split(" ")[0]}` : ""}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Describe what you want. DealMind compares marketplaces and shows only verified prices.
      </p>
    </div>
  );
}

export const SEARCH_STATUS: Record<
  string,
  { label: string; tone: "success" | "warning" | "danger" | "ai" | "neutral" }
> = {
  PENDING: { label: "Queued", tone: "neutral" },
  RUNNING: { label: "Running", tone: "ai" },
  COMPLETED: { label: "Completed", tone: "success" },
  PARTIAL: { label: "Partial", tone: "warning" },
  FAILED: { label: "Failed", tone: "danger" },
  NEEDS_CLARIFICATION: { label: "Needs details", tone: "warning" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export function SearchRow({ s }: { s: Search }) {
  const st = SEARCH_STATUS[s.status] ?? { label: s.status, tone: "neutral" as const };
  return (
    <li>
      <Link
        href={`/search/${s.id}`}
        className="flex items-center gap-3 rounded-lg px-2 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{s.query}</span>
          <span className="block text-xs text-muted-foreground">
            {relativeTime(s.createdAt)} · {s.resultCount} result{s.resultCount === 1 ? "" : "s"}
          </span>
        </span>
        <Badge tone={st.tone}>{st.label}</Badge>
      </Link>
    </li>
  );
}

export function RecentSearches() {
  const q = useSearches(1);
  return (
    <Card>
      <CardHeader
        title="Recent searches"
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/history">View all</Link>
          </Button>
        }
      />
      {q.isPending ? (
        <LoadingRows rows={3} label="Loading searches" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load your searches." onRetry={() => void q.refetch()} />
      ) : q.data.items.length ? (
        <ul className="-mx-2 flex flex-col">
          {q.data.items.slice(0, 5).map((s) => (
            <SearchRow key={s.id} s={s} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={SearchIcon}
          title="No searches yet"
          description="Your searches appear here."
        />
      )}
    </Card>
  );
}

/** Top deals from the user's latest finished search (real ranked results). */
export function BestDeals() {
  const list = useSearches(1);
  const latest = list.data?.items.find(
    (s) => (s.status === "COMPLETED" || s.status === "PARTIAL") && s.resultCount > 0,
  );
  const results = useSearchResults(latest?.id ?? "", latest ? latest.status : undefined);
  return (
    <Card>
      <CardHeader
        title="Best current deals"
        description={latest ? <>From your search “{latest.query}”</> : "From your latest search"}
      />
      {list.isPending || (latest && results.isPending) ? (
        <LoadingRows rows={3} label="Loading deals" />
      ) : !latest ? (
        <EmptyState
          icon={ShieldCheck}
          title="No deals yet"
          description="Run a search and the best verified deals show up here."
        />
      ) : results.isError ? (
        <ErrorState message="Couldn't load deals." onRetry={() => void results.refetch()} />
      ) : (
        <ul className="flex flex-col gap-3">
          {(results.data?.items ?? []).slice(0, 3).map((r) => (
            <li key={r.offer.id}>
              <Link
                href={`/products/${r.product.id}?variant=${r.offer.variantId}`}
                className="flex items-center gap-3 rounded-lg p-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <ProductImage src={r.product.imageUrl} alt="" size={48} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.product.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.offer.source.name}
                    {r.offer.source.isSample ? " · sample data" : ""}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span className="text-sm font-semibold tabular">
                    {rupees(r.pricing?.prices.deliveredPaise ?? r.offer.sellingPricePaise)}
                  </span>
                  {r.pricing ? <DiscountIndicator pricing={r.pricing} compact /> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RecentlyLaunched() {
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const q = useProducts({ sort: "newest", launchedAfter: since, inStock: true, pageSize: 3 });
  return (
    <Card>
      <CardHeader
        title="Recently launched"
        description="Launched in the last 6 months, with a current offer"
      />
      {q.isPending ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : q.isError ? (
        <ErrorState message="Couldn't load products." onRetry={() => void q.refetch()} />
      ) : q.data.items.length ? (
        <ul className="grid gap-3 sm:grid-cols-3">
          {q.data.items.map((p) => (
            <li key={p.id}>
              <ProductCard product={p} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={Rocket}
          title="No recent launches with offers"
          description="Products with a known launch date appear here."
        />
      )}
    </Card>
  );
}

/** Honest placeholder: no trustworthy popularity data exists, so nothing is invented. */
export function TrendingDeals() {
  return (
    <Card>
      <CardHeader title="Trending deals" />
      <EmptyState
        icon={Flame}
        title="Not available yet"
        description="DealMind doesn't collect reliable popularity data yet, so it won't guess what's trending."
      />
    </Card>
  );
}

export function WatchedUpdates() {
  const lists = useWatchlists();
  const first = lists.data?.items.find((w) => w.itemCount > 0);
  const detail = useWatchlist(first?.id ?? "");
  return (
    <Card>
      <CardHeader
        title="Watched products"
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/watchlists">Manage</Link>
          </Button>
        }
      />
      {lists.isPending ? (
        <LoadingRows rows={2} label="Loading watchlists" />
      ) : !first ? (
        <EmptyState
          icon={Star}
          title="Nothing watched yet"
          description="Use “Watch” on a product to follow its price."
        />
      ) : detail.isPending ? (
        <LoadingRows rows={2} />
      ) : (
        <ul className="flex flex-col gap-2">
          {(detail.data?.items ?? []).slice(0, 4).map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 text-sm">
              <Link
                href={`/products/${i.product.id}?variant=${i.variant.id}`}
                className="min-w-0 truncate hover:underline"
              >
                {i.product.name}
              </Link>
              <span className="shrink-0 font-medium tabular">
                {i.lowestPricePaise !== null ? (
                  rupees(i.lowestPricePaise)
                ) : (
                  <span className="text-muted-foreground">No offer</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ActiveAlerts() {
  const q = useAlerts("ACTIVE");
  return (
    <Card>
      <CardHeader
        title="Active price alerts"
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/alerts">Manage</Link>
          </Button>
        }
      />
      {q.isPending ? (
        <LoadingRows rows={2} label="Loading alerts" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load alerts." onRetry={() => void q.refetch()} />
      ) : q.data.items.length ? (
        <ul className="flex flex-col gap-2">
          {q.data.items.slice(0, 4).map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{a.product.name}</span>
              <span className="shrink-0 text-muted-foreground">
                at or below{" "}
                <span className="font-medium text-foreground tabular">
                  {rupees(a.targetPricePaise)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={BellRing}
          title="No active alerts"
          description="Create an alert from any product page."
        />
      )}
    </Card>
  );
}

export function ActivityOverview() {
  const usage = useUsage();
  const lists = useWatchlists();
  const watched = (lists.data?.items ?? []).reduce((n, w) => n + w.itemCount, 0);
  const tiles = usage.data
    ? [
        {
          label: "Searches today",
          value: `${usage.data.searchesToday.used} / ${usage.data.searchesToday.limit}`,
        },
        {
          label: "Active alerts",
          value: `${usage.data.activeAlerts.used} / ${usage.data.activeAlerts.limit}`,
        },
        { label: "Watched items", value: String(watched) },
      ]
    : [];
  return (
    <Card>
      <CardHeader title="Savings overview" />
      {usage.isPending ? (
        <Skeleton className="h-20" />
      ) : (
        <dl className="grid grid-cols-3 gap-3">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg bg-muted px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">{t.label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular">{t.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <PiggyBank aria-hidden className="mt-px size-4 shrink-0" />
        Realised savings need purchase data, which DealMind doesn't have yet — so no savings figure
        is shown.
      </p>
    </Card>
  );
}

export function SourceStatusCard() {
  const q = useSourceStatus();
  return (
    <Card>
      <CardHeader
        title="Marketplace status"
        description={
          q.data
            ? `${q.data.activeSources} of ${q.data.totalSources} marketplaces searchable`
            : undefined
        }
      />
      {q.isPending ? (
        <LoadingRows rows={3} label="Loading marketplace status" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load marketplace status." onRetry={() => void q.refetch()} />
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {q.data.sources.map((s) => {
            const ok = s.connectorStatus === "ACTIVE";
            const degraded = s.connectorStatus === "DEGRADED";
            return (
              <li key={s.slug} className="flex items-start gap-2.5">
                {ok ? (
                  <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : degraded ? (
                  <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                ) : (
                  <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {s.name}
                    {s.isSample ? <Badge tone="warning">Mock data</Badge> : null}
                  </span>
                  {s.statusReason && !ok ? (
                    <span className="block text-xs text-muted-foreground">{s.statusReason}</span>
                  ) : null}
                </span>
                <Badge tone={ok ? "success" : degraded ? "warning" : "neutral"}>
                  {s.connectorStatus.replace(/_/g, " ").toLowerCase()}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export const isRunning = (status?: string) =>
  status !== undefined && !(TERMINAL_SEARCH_STATUSES as readonly string[]).includes(status);
