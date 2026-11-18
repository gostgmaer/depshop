"use client";

/**
 * Price history for one variant: period (7 days … all stored history),
 * marketplace and MRP controls, the chart, and statistics of the selected
 * marketplace's observations in that period. Every figure comes from stored
 * PriceSnapshot rows; "all history" is phrased as "since tracking began",
 * never as all-time.
 */
import { type SeriesStats, describeStats, formatBasisPoints, seriesStats } from "@dealmind/shared";
import { ArrowDownRight, ArrowUpRight, LineChart, Minus } from "lucide-react";
import { useMemo } from "react";
import dynamic from "next/dynamic";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, NativeSelect, SegmentedControl } from "@/components/ui/misc";
import { Checkbox, Label } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { usePriceHistory } from "@/hooks/queries";
import { formatDate, formatDateTime, rupees } from "@/lib/format";
import type { HistoryDays } from "@/services";
import type { PriceHistory } from "@/types/api";

/** Recharts is loaded only when a chart is shown (keeps it out of the page's first load). */
const PriceHistoryChart = dynamic(
  () => import("@/components/charts/price-history-chart").then((m) => m.PriceHistoryChart),
  { ssr: false, loading: () => <Skeleton className="h-72" /> },
);

export const PERIODS = [
  { value: "7", label: "7D", days: 7 as HistoryDays, text: "last 7 days" },
  { value: "30", label: "30D", days: 30 as HistoryDays, text: "last 30 days" },
  { value: "90", label: "90D", days: 90 as HistoryDays, text: "last 90 days" },
  { value: "180", label: "180D", days: 180 as HistoryDays, text: "last 180 days" },
  { value: "365", label: "1Y", days: 365 as HistoryDays, text: "last 12 months" },
  { value: "all", label: "All", days: "all" as HistoryDays, text: null },
] as const;
export type PeriodValue = (typeof PERIODS)[number]["value"];
export const isPeriod = (v: string | null): v is PeriodValue => PERIODS.some((p) => p.value === v);

/** The observations of one marketplace (all its offers for this variant). */
export function sourcePoints(history: PriceHistory, slug: string) {
  return history.points.filter((p) => p.sourceSlug === slug);
}

const TREND: Record<SeriesStats["trend"], { text: string; icon: typeof Minus }> = {
  FALLING: { text: "Falling", icon: ArrowDownRight },
  RISING: { text: "Rising", icon: ArrowUpRight },
  STABLE: { text: "Stable", icon: Minus },
  INSUFFICIENT_DATA: { text: "Not enough data", icon: Minus },
};

export function PriceHistoryPanel({
  productId,
  variantId,
  period,
  source,
  showMrp,
  defaultSource,
  sourceNames,
  onChange,
}: {
  productId: string;
  variantId: string | undefined;
  period: PeriodValue;
  /** Selected marketplace slug, or "all". */
  source: string;
  showMrp: boolean;
  /** Marketplace used for statistics when "all" is selected (the current best offer's). */
  defaultSource: string | null;
  sourceNames: Record<string, string>;
  onChange: (next: { period?: PeriodValue; source?: string; mrp?: boolean }) => void;
}) {
  const p = PERIODS.find((x) => x.value === period)!;
  const history = usePriceHistory(productId, variantId, p.days);
  const slugs = useMemo(
    () => [...new Set((history.data?.points ?? []).map((x) => x.sourceSlug))].sort(),
    [history.data],
  );
  const names = { ...sourceNames };
  for (const s of slugs) names[s] ??= s;
  const statsSlug =
    source !== "all"
      ? source
      : defaultSource && slugs.includes(defaultSource)
        ? defaultSource
        : slugs[0];
  const stats = useMemo(
    () => (history.data && statsSlug ? seriesStats(sourcePoints(history.data, statsSlug)) : null),
    [history.data, statsSlug],
  );
  const statements = stats ? describeStats(stats, p.text) : [];
  const hasMrp = Boolean(
    history.data &&
    statsSlug &&
    sourcePoints(history.data, statsSlug).some((x) => x.mrpPaise !== null),
  );

  return (
    <Card>
      <CardHeader
        title="Price history"
        description="Observed selling prices from stored snapshots. Missing days are shown as gaps, never filled in."
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="History period"
          value={period}
          options={PERIODS.map((x) => ({ value: x.value, label: x.label }))}
          onChange={(v) => onChange({ period: v })}
        />
        <label className="sr-only" htmlFor="history-source">
          Marketplace
        </label>
        <NativeSelect
          id="history-source"
          className="h-10 w-52"
          value={source}
          onChange={(e) => onChange({ source: e.target.value })}
        >
          <option value="all">All marketplaces</option>
          {slugs.map((s) => (
            <option key={s} value={s}>
              {names[s]}
            </option>
          ))}
        </NativeSelect>
        {source !== "all" && hasMrp ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="history-mrp"
              checked={showMrp}
              onCheckedChange={(c) => onChange({ mrp: c === true })}
            />
            <Label htmlFor="history-mrp" className="font-normal">
              Show MRP
            </Label>
          </div>
        ) : null}
      </div>

      {history.isPending ? (
        <div role="status">
          <span className="sr-only">Loading price history…</span>
          <Skeleton className="h-72" />
        </div>
      ) : history.isError ? (
        <ErrorState message="Couldn't load price history." onRetry={() => void history.refetch()} />
      ) : !history.data.points.length ? (
        <EmptyState
          icon={LineChart}
          title={p.text ? `No price observations in the ${p.text}` : "No price observations yet"}
          description={
            history.data.trackingSince
              ? `DealMind has observed this variant since ${formatDate(history.data.trackingSince)}. Try a longer period.`
              : "History builds up as DealMind observes prices over time. Nothing is estimated in the meantime."
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <PriceHistoryChart
            history={history.data}
            sourceNames={names}
            source={source}
            showMrp={showMrp && source !== "all"}
            reference={
              source !== "all" && stats?.lowest && stats.highest && stats.averagePaise !== null
                ? {
                    lowestPaise: stats.lowest.pricePaise,
                    highestPaise: stats.highest.pricePaise,
                    averagePaise: stats.averagePaise,
                  }
                : null
            }
          />
          {stats && statsSlug ? (
            <StatsPanel
              stats={stats}
              statements={statements}
              marketplace={names[statsSlug] ?? statsSlug}
              chosen={source !== "all"}
              trackingSince={history.data.trackingSince}
              allHistory={p.text === null}
            />
          ) : null}
        </div>
      )}
    </Card>
  );
}

function StatsPanel({
  stats,
  statements,
  marketplace,
  chosen,
  trackingSince,
  allHistory,
}: {
  stats: SeriesStats;
  statements: string[];
  marketplace: string;
  chosen: boolean;
  trackingSince: string | null;
  allHistory: boolean;
}) {
  const T = TREND[stats.trend];
  const pct = (bp: number | null) =>
    bp === null ? "—" : bp === 0 ? "0%" : `${bp > 0 ? "+" : "−"}${formatBasisPoints(Math.abs(bp))}`;
  const rows: [string, string, string?][] = [
    [
      "Current observed",
      rupees(stats.current?.pricePaise),
      stats.current ? formatDateTime(stats.current.at) : undefined,
    ],
    [
      "Previous observed",
      stats.previous ? rupees(stats.previous.pricePaise) : "—",
      stats.previous ? formatDateTime(stats.previous.at) : undefined,
    ],
    [
      "Lowest observed",
      rupees(stats.lowest?.pricePaise),
      stats.lowest ? formatDate(stats.lowest.at) : undefined,
    ],
    [
      "Highest observed",
      rupees(stats.highest?.pricePaise),
      stats.highest ? formatDate(stats.highest.at) : undefined,
    ],
    [
      "Average observed",
      rupees(stats.averagePaise),
      `mean of ${stats.observations} observation${stats.observations === 1 ? "" : "s"}`,
    ],
    ["Change over period", pct(stats.periodChangeBp), "first to latest observation"],
  ];
  return (
    <section aria-label="Price statistics" className="flex flex-col gap-3 text-sm">
      <p className="text-xs text-muted-foreground">
        {chosen ? "Selected marketplace" : "Statistics for"}:{" "}
        <span className="font-medium text-foreground">{marketplace}</span>
        {chosen ? null : " (current best offer; pick another above)"}
      </p>
      <dl className="grid grid-cols-2 gap-2">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="rounded-lg bg-muted px-3 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular">{value}</dd>
            {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
          </div>
        ))}
      </dl>
      <p className="flex items-center gap-1.5 text-xs">
        <T.icon aria-hidden className="size-3.5" /> Trend:{" "}
        <span className="font-medium">{T.text}</span>
        {stats.trend === "INSUFFICIENT_DATA" ? " (needs observations spanning 3+ days)" : null}
      </p>
      {statements.length ? (
        <ul className="flex flex-col gap-1 text-xs" aria-label="What the history shows">
          {statements.map((s) => (
            <li key={s} className="rounded-md border border-border px-2.5 py-1.5">
              {s}
            </li>
          ))}
        </ul>
      ) : null}
      {stats.changes.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-accent">
            Price changes ({stats.changes.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {[...stats.changes]
              .reverse()
              .slice(0, 10)
              .map((c) => (
                <li key={c.at} className="flex justify-between gap-2 tabular">
                  <span className="text-muted-foreground">{formatDate(c.at)}</span>
                  <span>
                    {rupees(c.fromPaise)} → {rupees(c.toPaise)}
                  </span>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {stats.gaps
          ? `${stats.gaps} gap${stats.gaps === 1 ? "" : "s"} of more than 48 hours without an observation in this period. `
          : ""}
        {allHistory && stats.firstAt
          ? `DealMind has no prices from ${marketplace} before ${formatDate(stats.firstAt)}${trackingSince && trackingSince < stats.firstAt ? ` (other marketplaces from ${formatDate(trackingSince)})` : ""}, so these are not all-time figures.`
          : "“All-time low” is never claimed from a limited period."}
      </p>
    </section>
  );
}
