"use client";

/**
 * Counts over time as bars (Recharts). One y-axis, recessive grid, rounded
 * data ends, a 2px surface gap between stacked segments, fixed series order
 * (validated palette in globals.css), legend for >= 2 series, hover tooltip,
 * and a table view so no number depends on reading the chart.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { num } from "./admin-ui";

export interface BarSeries {
  key: string;
  label: string;
}
const COLORS = ["var(--color-series-1)", "var(--color-series-2)", "var(--color-series-3)"];

export function AdminBarChart({
  rows,
  xKey,
  series,
  stacked = false,
  label,
  formatX = (v) => v,
}: {
  rows: Record<string, string | number>[];
  xKey: string;
  series: BarSeries[];
  stacked?: boolean;
  label: string;
  formatX?: (v: string) => string;
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No data in this period.</p>;
  return (
    <figure className="flex flex-col gap-3">
      <div className="h-64 w-full" role="img" aria-label={`${label} (chart; table below)`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barGap={2}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="0" />
            <XAxis
              dataKey={xKey}
              tickFormatter={(v: string) => formatX(String(v))}
              tick={{ fontSize: 12, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
              minTickGap={16}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 12, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              cursor={{ fill: "var(--color-muted)" }}
              labelFormatter={(v) => (typeof v === "string" ? formatX(v) : v)}
              formatter={(value, name) => [num(Number(value)), name]}
              contentStyle={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                color: "var(--color-foreground)",
                fontSize: 12,
              }}
            />
            {series.length > 1 ? (
              <Legend
                iconType="square"
                iconSize={10}
                wrapperStyle={{ fontSize: 12, color: "var(--color-foreground)" }}
              />
            ) : null}
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={COLORS[i % COLORS.length]}
                stackId={stacked ? "a" : undefined}
                radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]}
                stroke="var(--color-surface)"
                strokeWidth={stacked ? 2 : 0}
                maxBarSize={28}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr>
                <th scope="col" className="py-1 text-left font-medium">
                  {xKey === "day" ? "Day" : "Period"}
                </th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="py-1 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r[xKey])} className="border-t border-border">
                  <th scope="row" className="py-1 text-left font-normal">
                    {formatX(String(r[xKey]))}
                  </th>
                  {series.map((s) => (
                    <td key={s.key} className="py-1 text-right tabular">
                      {num(Number(r[s.key]))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
