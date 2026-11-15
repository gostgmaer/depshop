"use client";

/**
 * Price history from stored PriceSnapshot observations (Recharts).
 *
 * - One step line per marketplace offer: a price is drawn as held only
 *   between two real observations at most GAP_HOURS apart. A longer gap
 *   breaks the line, so nothing unobserved looks verified. Dots mark the
 *   actual observations.
 * - The MRP (when the source states it) is shown as a dashed line for a
 *   single marketplace.
 * - One y-axis, recessive grid, thin 2px lines, legend + dash patterns (identity
 *   never by colour alone), keyboard-accessible tooltip, and a table view.
 *   Colours follow the marketplace in a fixed, validated order (globals.css).
 */
import { GAP_HOURS } from "@dealmind/shared";
import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDate, formatDateTime, rupees } from "@/lib/format";
import type { PriceHistory } from "@/types/api";

export const SERIES_COLORS = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
  "var(--color-series-5)",
];
export const SERIES_DASHES = ["", "6 4", "2 3", "8 3 2 3", "1 4"];
const GAP_MS = GAP_HOURS * 3_600_000;

export interface Series {
  key: string;
  offerId: string;
  slug: string;
  label: string;
  points: { t: number; price: number; mrp: number | null }[];
  color: string;
  dash: string;
}

/** One series per offer, labelled by marketplace, in a stable (slug) order. */
export function buildSeries(
  history: PriceHistory,
  sourceNames: Record<string, string> = {},
): Series[] {
  const byOffer = new Map<string, { slug: string; points: Series["points"] }>();
  for (const p of history.points) {
    const s = byOffer.get(p.offerId) ?? { slug: p.sourceSlug, points: [] };
    s.points.push({ t: Date.parse(p.observedAt), price: p.sellingPricePaise, mrp: p.mrpPaise });
    byOffer.set(p.offerId, s);
  }
  const entries = [...byOffer.entries()].sort(
    (a, b) => a[1].slug.localeCompare(b[1].slug) || a[0].localeCompare(b[0]),
  );
  const perSlug = new Map<string, number>();
  return entries.slice(0, SERIES_COLORS.length).map(([offerId, s], i) => {
    const n = (perSlug.get(s.slug) ?? 0) + 1;
    perSlug.set(s.slug, n);
    const name = sourceNames[s.slug] ?? s.slug;
    return {
      key: `s${i}`,
      offerId,
      slug: s.slug,
      label: n > 1 ? `${name} (${n})` : name,
      points: s.points.sort((a, b) => a.t - b.t),
      color: SERIES_COLORS[i]!,
      dash: SERIES_DASHES[i]!,
    };
  });
}

/**
 * The last observation at or before t, if the series is "held" there: t lies
 * between two observations at most GAP_HOURS apart, or within GAP_HOURS after
 * the latest one. Otherwise null (unobserved — drawn as a gap).
 */
export function priceAt(
  s: Series,
  t: number,
): { price: number; mrp: number | null; observedAt: number } | null {
  let i = -1;
  for (let k = 0; k < s.points.length; k += 1) {
    if (s.points[k]!.t > t) break;
    i = k;
  }
  if (i < 0) return null;
  const p = s.points[i]!;
  const next = s.points[i + 1];
  const held = p.t === t || (next ? next.t - p.t <= GAP_MS : t - p.t <= GAP_MS);
  return held ? { price: p.price, mrp: p.mrp, observedAt: p.t } : null;
}

export type ChartRow = { t: number } & Record<string, number | null>;

/** Rows at every observation time (+ the period end); unobserved cells are null. */
export function chartRows(series: Series[], endT: number): ChartRow[] {
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const last = times.at(-1);
  if (last !== undefined && endT > last) times.push(endT);
  return times.map((t) => {
    const row: ChartRow = { t };
    for (const s of series) {
      const v = priceAt(s, t);
      row[s.key] = v?.price ?? null;
      row[`${s.key}_mrp`] = v?.mrp ?? null;
      row[`${s.key}_obs`] = s.points.some((p) => p.t === t) ? 1 : 0;
    }
    return row;
  });
}

/** A round tick step (₹1/2/2.5/5 × 10ⁿ in paise) giving about four intervals. */
export function niceStep(range: number): number {
  const raw = Math.max(100, range / 4);
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw)!;
}
export function niceDomain(lo: number, hi: number): [number, number] {
  const step = niceStep(hi - lo);
  return [Math.max(0, Math.floor(lo / step) * step), Math.ceil(hi / step) * step];
}
export function niceTicks(lo: number, hi: number): number[] {
  const step = niceStep(hi - lo);
  const [a, b] = niceDomain(lo, hi);
  const out: number[] = [];
  for (let v = a; v <= b; v += step) out.push(v);
  return out;
}

/** Text alternative for the chart: range and observation count per marketplace. */
export function chartSummary(history: PriceHistory, series: Series[]): string {
  return `Price history from ${formatDate(history.from)} to ${formatDate(history.to)}: ${series
    .map((s) => {
      const ps = s.points.map((p) => p.price);
      return `${s.label} ${rupees(Math.min(...ps))} to ${rupees(Math.max(...ps))} over ${s.points.length} observation${s.points.length === 1 ? "" : "s"}`;
    })
    .join("; ")}.`;
}

interface DotProps {
  cx?: number;
  cy?: number;
  payload?: ChartRow;
}

export function PriceHistoryChart({
  history,
  sourceNames,
  source = "all",
  showMrp = false,
  reference,
}: {
  history: PriceHistory;
  sourceNames?: Record<string, string>;
  /** Marketplace slug, or "all". */
  source?: string;
  showMrp?: boolean;
  /** Lowest / average / highest of the selected series, drawn as labelled reference lines. */
  reference?: { lowestPaise: number; highestPaise: number; averagePaise: number } | null;
}) {
  const all = useMemo(() => buildSeries(history, sourceNames), [history, sourceNames]);
  const series = source === "all" ? all : all.filter((s) => s.slug === source);
  const endT = Date.parse(history.to);
  const rows = useMemo(() => chartRows(series, endT), [series, endT]);
  const totalOffers = new Set(history.points.map((p) => p.offerId)).size;
  if (!series.length) return null;

  const single = series.length === 1 ? series[0]! : null;
  const prices = series.flatMap((s) =>
    s.points.flatMap((p) => (showMrp && single && p.mrp !== null ? [p.price, p.mrp] : [p.price])),
  );
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = Math.max(100, Math.round((hi - lo) * 0.12) || Math.round(lo * 0.04));
  const from = Date.parse(history.from);
  const summary = chartSummary(history, series);

  const dot =
    (s: Series) =>
    ({ cx, cy, payload }: DotProps) =>
      payload?.[`${s.key}_obs`] && cx !== undefined && cy !== undefined ? (
        <circle
          key={`${s.key}-${payload.t}`}
          cx={cx}
          cy={cy}
          r={3}
          fill={s.color}
          stroke="var(--color-surface)"
          strokeWidth={1.5}
        />
      ) : (
        <g key={`${s.key}-${payload?.t ?? "x"}`} />
      );

  return (
    <figure className="flex flex-col gap-3">
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <svg width="22" height="8" aria-hidden>
              <line
                x1="1"
                y1="4"
                x2="21"
                y2="4"
                stroke={s.color}
                strokeWidth="2"
                strokeDasharray={s.dash}
              />
            </svg>
            {s.label}
          </li>
        ))}
        {showMrp && single ? (
          <li className="flex items-center gap-1.5 text-muted-foreground">
            <svg width="22" height="8" aria-hidden>
              <line
                x1="1"
                y1="4"
                x2="21"
                y2="4"
                stroke="var(--color-muted-foreground)"
                strokeWidth="1.5"
                strokeDasharray="3 3"
              />
            </svg>
            MRP (as stated)
          </li>
        ) : null}
      </ul>
      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
            accessibilityLayer
            aria-label={`${summary} Use the arrow keys to step through observations.`}
          >
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[from, endT]}
              tickFormatter={(t: number) => formatDate(new Date(t).toISOString())}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              stroke="var(--color-border)"
              minTickGap={32}
            />
            <YAxis
              domain={niceDomain(lo - pad, hi + pad)}
              ticks={niceTicks(lo - pad, hi + pad)}
              tickFormatter={(v: number) => rupees(Math.round(v))}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
              stroke="var(--color-border)"
              width={76}
              allowDecimals={false}
            />
            {reference && single ? (
              <>
                <ReferenceLine
                  y={reference.lowestPaise}
                  stroke="var(--color-primary)"
                  strokeDasharray="2 4"
                  label={{
                    value: `Low ${rupees(reference.lowestPaise)}`,
                    position: "insideBottomLeft",
                    fontSize: 10,
                    fill: "var(--color-muted-foreground)",
                  }}
                />
                <ReferenceLine
                  y={reference.highestPaise}
                  stroke="var(--color-muted-foreground)"
                  strokeDasharray="2 4"
                  label={{
                    value: `High ${rupees(reference.highestPaise)}`,
                    position: "insideTopLeft",
                    fontSize: 10,
                    fill: "var(--color-muted-foreground)",
                  }}
                />
                <ReferenceLine
                  y={reference.averagePaise}
                  stroke="var(--color-muted-foreground)"
                  strokeOpacity={0.6}
                  strokeDasharray="1 3"
                  label={{
                    value: `Avg ${rupees(reference.averagePaise)}`,
                    position: "insideTopRight",
                    fontSize: 10,
                    fill: "var(--color-muted-foreground)",
                  }}
                />
              </>
            ) : null}
            <Tooltip
              content={({ active, label }) =>
                active && typeof label === "number" ? (
                  <ChartTooltip t={label} series={series} showMrp={showMrp && !!single} />
                ) : null
              }
              cursor={{ stroke: "var(--color-muted-foreground)", strokeWidth: 1 }}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type="stepAfter"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dash}
                dot={dot(s)}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
            {showMrp && single ? (
              <Line
                dataKey={`${single.key}_mrp`}
                name="MRP"
                type="stepAfter"
                stroke="var(--color-muted-foreground)"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                dot={false}
                activeDot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="text-xs text-muted-foreground">
        Dots are actual observations. A line joins two observations only when they are at most{" "}
        {GAP_HOURS} hours apart; a gap means no observation, not a price.
        {totalOffers > all.length ? ` Showing ${all.length} of ${totalOffers} offers.` : ""}
        {history.truncated ? " Only the most recent observations of this period are shown." : ""}
      </figcaption>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-accent">Show as table</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <caption className="sr-only">Observed prices</caption>
            <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Observed
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Marketplace
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Selling price
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  MRP
                </th>
              </tr>
            </thead>
            <tbody>
              {series
                .flatMap((s) => s.points.map((p) => ({ s, p })))
                .sort((a, b) => b.p.t - a.p.t)
                .map(({ s, p }) => (
                  <tr key={`${s.key}-${p.t}`} className="border-t border-border">
                    <td className="px-3 py-1.5">{formatDateTime(new Date(p.t).toISOString())}</td>
                    <td className="px-3 py-1.5">{s.label}</td>
                    <td className="px-3 py-1.5 text-right tabular">{rupees(p.price)}</td>
                    <td className="px-3 py-1.5 text-right tabular">
                      {p.mrp === null ? "Not stated" : rupees(p.mrp)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function ChartTooltip({ t, series, showMrp }: { t: number; series: Series[]; showMrp: boolean }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
    >
      <p className="mb-1 font-medium">{formatDateTime(new Date(t).toISOString())}</p>
      <ul className="flex flex-col gap-0.5">
        {series.map((s) => {
          const v = priceAt(s, t);
          return (
            <li key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />
                {s.label}
              </span>
              <span className="tabular">
                {v ? (
                  <>
                    {rupees(v.price)}
                    {v.observedAt !== t ? (
                      <span className="text-muted-foreground">
                        {" "}
                        (observed {formatDate(new Date(v.observedAt).toISOString())})
                      </span>
                    ) : null}
                    {showMrp && v.mrp !== null ? (
                      <span className="text-muted-foreground"> · MRP {rupees(v.mrp)}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">no observation</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
