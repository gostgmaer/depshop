/**
 * Statistics over one marketplace's observed price series for a chosen
 * period. Integer paise and basis points only. Nothing is interpolated: every
 * figure comes from stored observations, and the wording never claims more
 * than the observations cover (no "all-time low").
 */
import { formatBasisPoints, formatPaise, signedRatioBp } from "./money.js";

export interface ObservedPoint {
  sellingPricePaise: number;
  mrpPaise: number | null;
  observedAt: string;
}

export interface PriceAt {
  pricePaise: number;
  at: string;
}

export type SeriesTrend = "FALLING" | "RISING" | "STABLE" | "INSUFFICIENT_DATA";

export interface SeriesStats {
  observations: number;
  current: PriceAt | null;
  previous: PriceAt | null;
  /** current − previous observation (signed paise / bp); null with fewer than 2 observations. */
  changeFromPreviousPaise: number | null;
  changeFromPreviousBp: number | null;
  lowest: PriceAt | null;
  highest: PriceAt | null;
  /** Mean of the observations (floored); not time-weighted. */
  averagePaise: number | null;
  currentVsAverageBp: number | null;
  /** current vs the first observation of the period. */
  periodChangeBp: number | null;
  trend: SeriesTrend;
  firstAt: string | null;
  /** Each observed price change, oldest first. */
  changes: { at: string; fromPaise: number; toPaise: number }[];
  /** Intervals between consecutive observations longer than GAP_HOURS. */
  gaps: number;
}

/** Same threshold the pricing engine uses for history coverage. */
export const GAP_HOURS = 48;
/** |change| below 1% over the period is "stable". */
const STABLE_BP = 100;
const MIN_TREND_SPAN_MS = 3 * 86_400_000;

export function seriesStats(points: readonly ObservedPoint[]): SeriesStats {
  const pts = [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const n = pts.length;
  const empty: SeriesStats = {
    observations: 0,
    current: null,
    previous: null,
    changeFromPreviousPaise: null,
    changeFromPreviousBp: null,
    lowest: null,
    highest: null,
    averagePaise: null,
    currentVsAverageBp: null,
    periodChangeBp: null,
    trend: "INSUFFICIENT_DATA",
    firstAt: null,
    changes: [],
    gaps: 0,
  };
  if (!n) return empty;
  const at = (p: ObservedPoint): PriceAt => ({ pricePaise: p.sellingPricePaise, at: p.observedAt });
  const first = pts[0]!;
  const last = pts[n - 1]!;
  const prev = n > 1 ? pts[n - 2]! : null;
  let lowest = first;
  let highest = first;
  let sum = 0n;
  let gaps = 0;
  const changes: SeriesStats["changes"] = [];
  pts.forEach((p, i) => {
    // Earliest wins on ties for the lowest/highest date shown.
    if (p.sellingPricePaise < lowest.sellingPricePaise) lowest = p;
    if (p.sellingPricePaise > highest.sellingPricePaise) highest = p;
    sum += BigInt(p.sellingPricePaise);
    const before = pts[i - 1];
    if (before) {
      if (Date.parse(p.observedAt) - Date.parse(before.observedAt) > GAP_HOURS * 3_600_000)
        gaps += 1;
      if (p.sellingPricePaise !== before.sellingPricePaise)
        changes.push({
          at: p.observedAt,
          fromPaise: before.sellingPricePaise,
          toPaise: p.sellingPricePaise,
        });
    }
  });
  const average = Number(sum / BigInt(n));
  const cur = last.sellingPricePaise;
  const periodChangeBp =
    n > 1
      ? signedRatioBp(BigInt(cur - first.sellingPricePaise), BigInt(first.sellingPricePaise))
      : null;
  const span = Date.parse(last.observedAt) - Date.parse(first.observedAt);
  const trend: SeriesTrend =
    periodChangeBp === null || span < MIN_TREND_SPAN_MS
      ? "INSUFFICIENT_DATA"
      : periodChangeBp <= -STABLE_BP
        ? "FALLING"
        : periodChangeBp >= STABLE_BP
          ? "RISING"
          : "STABLE";
  return {
    observations: n,
    current: at(last),
    previous: prev ? at(prev) : null,
    changeFromPreviousPaise: prev ? cur - prev.sellingPricePaise : null,
    changeFromPreviousBp: prev
      ? signedRatioBp(BigInt(cur - prev.sellingPricePaise), BigInt(prev.sellingPricePaise))
      : null,
    lowest: at(lowest),
    highest: at(highest),
    averagePaise: average,
    currentVsAverageBp: signedRatioBp(BigInt(cur - average), BigInt(average)),
    periodChangeBp,
    trend,
    firstAt: first.observedAt,
    changes,
    gaps,
  };
}

const dateText = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});
const fmtDate = (iso: string) => dateText.format(new Date(iso));

/**
 * Plain-language statements for the stats.
 * `period`: "last 90 days", or null for all stored history (then phrased as
 * "since tracking began on …", never as all-time).
 */
export function describeStats(s: SeriesStats, period: string | null): string[] {
  if (!s.current || !s.firstAt) return [];
  const scope = period ? `in the ${period}` : `since tracking began on ${fmtDate(s.firstAt)}`;
  const out: string[] = [];
  if (s.observations >= 2 && s.lowest && s.current.pricePaise === s.lowest.pricePaise)
    out.push(`Lowest observed price ${scope}.`);
  if (s.observations >= 2 && s.highest && s.current.pricePaise === s.highest.pricePaise)
    out.push(`Highest observed price ${scope}.`);
  if (s.observations >= 2 && s.currentVsAverageBp !== null && s.averagePaise !== null) {
    const bp = s.currentVsAverageBp;
    out.push(
      bp === 0
        ? `Price equals its average ${scope} (${formatPaise(s.averagePaise)}, ${s.observations} observations).`
        : `Price is ${formatBasisPoints(Math.abs(bp))} ${bp < 0 ? "below" : "above"} its average ${scope} (${formatPaise(s.averagePaise)}, ${s.observations} observations).`,
    );
  }
  if (s.previous && s.changeFromPreviousPaise !== null) {
    const d = s.changeFromPreviousPaise;
    out.push(
      d === 0
        ? `Unchanged since the previous observation (${fmtDate(s.previous.at)}).`
        : `Price ${d > 0 ? "increased" : "decreased"} by ${formatPaise(Math.abs(d))} since the previous observation (${fmtDate(s.previous.at)}).`,
    );
  }
  if (s.observations < 2)
    out.push(`Only one observation ${scope}, so there is nothing to compare yet.`);
  return out;
}
