"use client";

/**
 * Price history: one step line per marketplace offer (prices hold until the
 * next observation). Thin 2px lines, one y-axis, recessive grid, crosshair
 * tooltip (pointer + arrow keys), legend + direct end labels + dash patterns
 * (identity never by colour alone), and a table view. Series colours follow
 * the marketplace in a fixed, validated order (see globals.css).
 */
import { type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from "react";
import { formatDate, formatDateTime, rupees } from "@/lib/format";
import type { PriceHistory } from "@/types/api";

const COLORS = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
  "var(--color-series-5)",
];
const DASHES = ["", "6 4", "2 3", "8 3 2 3", "1 4"];
const W = 720;
const H = 260;
const PAD = { top: 16, right: 96, bottom: 28, left: 64 };

export interface Series {
  key: string;
  label: string;
  points: { t: number; price: number }[];
  color: string;
  dash: string;
}

/** Groups history points into one series per offer, labelled by marketplace. */
export function buildSeries(
  history: PriceHistory,
  sourceNames: Record<string, string> = {},
): Series[] {
  const byOffer = new Map<string, { slug: string; points: { t: number; price: number }[] }>();
  for (const p of history.points) {
    const s = byOffer.get(p.offerId) ?? { slug: p.sourceSlug, points: [] };
    s.points.push({ t: new Date(p.observedAt).getTime(), price: p.sellingPricePaise });
    byOffer.set(p.offerId, s);
  }
  // Stable order: by marketplace slug, then offer id (colour follows the entity, not its rank).
  const entries = [...byOffer.entries()].sort(
    (a, b) => a[1].slug.localeCompare(b[1].slug) || a[0].localeCompare(b[0]),
  );
  const perSlug = new Map<string, number>();
  return entries.slice(0, COLORS.length).map(([key, s], i) => {
    const n = (perSlug.get(s.slug) ?? 0) + 1;
    perSlug.set(s.slug, n);
    const name = sourceNames[s.slug] ?? s.slug;
    return {
      key,
      label: n > 1 ? `${name} (${n})` : name,
      points: s.points.sort((a, b) => a.t - b.t),
      color: COLORS[i]!,
      dash: DASHES[i]!,
    };
  });
}

/** Price of a series at time t: the last observation at or before t. */
export function priceAt(s: Series, t: number): number | null {
  let v: number | null = null;
  for (const p of s.points) {
    if (p.t > t) break;
    v = p.price;
  }
  return v;
}

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

export function PriceHistoryChart({
  history,
  sourceNames,
}: {
  history: PriceHistory;
  sourceNames?: Record<string, string>;
}) {
  const series = useMemo(() => buildSeries(history, sourceNames), [history, sourceNames]);
  const [cursor, setCursor] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const totalSeries = new Set(history.points.map((p) => p.offerId)).size;

  const t0 = new Date(history.from).getTime();
  const t1 = new Date(history.to).getTime();
  const prices = series.flatMap((s) => s.points.map((p) => p.price));
  if (!series.length || !prices.length) return null;
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const padY = Math.max(1, Math.round((hi - lo) * 0.12)) || Math.round(lo * 0.05) || 100;
  const yMin = Math.max(0, lo - padY);
  const yMax = hi + padY;
  const x = (t: number) =>
    PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) =>
    PAD.top + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * (H - PAD.top - PAD.bottom);
  const ticks = niceTicks(yMin, yMax);
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);

  const path = (s: Series) => {
    let d = "";
    s.points.forEach((p, i) => {
      const px = x(Math.max(p.t, t0));
      d += i === 0 ? `M${px},${y(p.price)}` : `H${px}V${y(p.price)}`;
    });
    return `${d}H${x(t1)}`;
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (t1 - t0);
    setCursor(Math.min(t1, Math.max(t0, t)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Escape") return setCursor(null);
    const idx = cursor === null ? times.length - 1 : times.findIndex((t) => t >= cursor);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? times.length - 1
          : Math.min(times.length - 1, Math.max(0, idx + (e.key === "ArrowRight" ? 1 : -1)));
    setCursor(times[next] ?? null);
  };

  const lastLabels = series
    .map((s) => ({ s, v: s.points[s.points.length - 1]!.price }))
    .sort((a, b) => b.v - a.v);
  // Nudge end labels apart (min 14px) so they never collide.
  const labelY: Record<string, number> = {};
  let prevY = -Infinity;
  for (const { s, v } of lastLabels) {
    const yy = Math.max(y(v), prevY + 14);
    labelY[s.key] = yy;
    prevY = yy;
  }

  const summary = `Price history from ${formatDate(history.from)} to ${formatDate(history.to)}: ${series
    .map((s) => `${s.label} now ${rupees(s.points[s.points.length - 1]!.price)}`)
    .join(
      "; ",
    )}. Lowest observed ${rupees(history.lowestPricePaise)}, highest ${rupees(history.highestPricePaise)}.`;

  return (
    <figure className="flex flex-col gap-3">
      <ul
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label="Legend"
      >
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <svg width="22" height="8" aria-hidden>
              <line
                x1="0"
                x2="22"
                y1="4"
                y2="4"
                stroke={s.color}
                strokeWidth="2"
                strokeDasharray={s.dash}
              />
            </svg>
            <span className="text-foreground">{s.label}</span>
          </li>
        ))}
      </ul>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          role="img"
          aria-label={summary}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setCursor(null)}
          onKeyDown={onKey}
          onBlur={() => setCursor(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--color-border)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={y(v)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular"
              >
                {rupees(v)}
              </text>
            </g>
          ))}
          <text x={PAD.left} y={H - 8} className="fill-muted-foreground text-[11px]">
            {formatDate(history.from)}
          </text>
          <text
            x={W - PAD.right}
            y={H - 8}
            textAnchor="end"
            className="fill-muted-foreground text-[11px]"
          >
            {formatDate(history.to)}
          </text>
          {series.map((s) => (
            <path
              key={s.key}
              d={path(s)}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeDasharray={s.dash}
              strokeLinejoin="round"
            />
          ))}
          {series.map((s) => (
            <text
              key={`${s.key}-label`}
              x={W - PAD.right + 6}
              y={labelY[s.key]}
              dy="0.32em"
              className="fill-foreground text-[11px]"
            >
              {s.label.length > 14 ? `${s.label.slice(0, 13)}…` : s.label}
            </text>
          ))}
          {cursor !== null ? (
            <g>
              <line
                x1={x(cursor)}
                x2={x(cursor)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="var(--color-muted-foreground)"
                strokeWidth="1"
              />
              {series.map((s) => {
                const v = priceAt(s, cursor);
                return v === null ? null : (
                  <circle
                    key={s.key}
                    cx={x(cursor)}
                    cy={y(v)}
                    r="4.5"
                    fill={s.color}
                    stroke="var(--color-surface)"
                    strokeWidth="2"
                  />
                );
              })}
            </g>
          ) : null}
        </svg>
        {cursor !== null ? (
          <div
            role="status"
            className="pointer-events-none absolute top-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
            style={{ left: `${Math.min(70, (x(cursor) / W) * 100)}%` }}
          >
            <p className="mb-1 font-medium">{formatDateTime(new Date(cursor).toISOString())}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    className="size-2 rounded-full"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  {s.label}
                </span>
                <span className="tabular text-foreground">{rupees(priceAt(s, cursor))}</span>
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <figcaption className="text-xs text-muted-foreground">
        Selling prices as observed by DealMind (each line holds until the next observation). Use ← →
        to inspect.
        {totalSeries > series.length ? ` Showing ${series.length} of ${totalSeries} offers.` : ""}
      </figcaption>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-accent">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <caption className="sr-only">Observed prices</caption>
            <thead className="sticky top-0 bg-muted text-left">
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
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
