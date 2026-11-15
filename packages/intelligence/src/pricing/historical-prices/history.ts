/**
 * Historical price intelligence for ONE offer (one marketplace listing), from
 * its append-only PriceSnapshot rows.
 *
 * Coverage: a snapshot tells us the price from its time until the next
 * snapshot, but only for up to `maxGapHours` (snapshots are appended on change
 * or every few hours while an offer is observed). Time not covered is missing
 * data, and every window reports how much of it was actually observed.
 *
 * Claims:
 *   - "Lowest observed price in the last N days" only for a window observed
 *     for at least `minCoverageBp` of its length;
 *   - "all-time low" only when observation started within `launchGraceDays`
 *     of the product's launch AND coverage since then is complete. That is
 *     still per marketplace: prices elsewhere were not observed by this offer.
 *
 * BigInt for every price; averages are rounded down to whole paise.
 */
import { bigPaise, paiseFromBig, signedRatioBp } from "@dealmind/shared";

export interface Observation {
  sellingPricePaise: bigint | number;
  observedAt: Date;
}

export interface HistoryOptions {
  windowsDays: number[];
  maxGapHours: number;
  /** A window claim needs this much of the window observed (bp). */
  minCoverageBp: number;
  /** All-time claims need tracking to start this close to launch. */
  launchGraceDays: number;
  /** Trend: current vs 30-day average beyond ± this (bp). */
  trendThresholdBp: number;
}

export const DEFAULT_HISTORY_OPTIONS: HistoryOptions = {
  windowsDays: [7, 30, 90, 180],
  maxGapHours: 48,
  minCoverageBp: 9_000,
  launchGraceDays: 7,
  trendThresholdBp: 300,
};

export interface WindowStats {
  days: number;
  observations: number;
  lowestPaise: number | null;
  lowestObservedAt: string | null;
  highestPaise: number | null;
  averagePaise: number | null;
  /** Share of the window for which the price was observed (bp). */
  coverageBp: number;
  /** Current price ≤ the window's lowest observation. */
  currentIsLowest: boolean;
}

export type PriceTrend = "FALLING" | "RISING" | "STABLE" | "INSUFFICIENT_DATA";

export interface LowestClaim {
  kind: "ALL_TIME_LOW" | "LOWEST_IN_WINDOW" | "NONE";
  days: number | null;
  /** Wording safe to show to a user. */
  text: string | null;
}

export interface PriceHistoryStats {
  currentPaise: number;
  firstObservedAt: string | null;
  observations: number;
  windows: WindowStats[];
  /** Mean of every observation in the longest window (rounded down). */
  historicalAveragePaise: number | null;
  /** The last observed price that differs from the current one. */
  previousPricePaise: number | null;
  previousObservedAt: string | null;
  /** (current − previous) / previous, bp, signed. */
  changeFromPreviousBp: number | null;
  /** (current − 30-day average) / average, bp, signed. */
  changeVs30DayAverageBp: number | null;
  trend: PriceTrend;
  lowestClaim: LowestClaim;
  /** Verified recent drop vs the 30-day median before the current price began. */
  recentDrop: { referencePaise: number; dropPaise: number; dropBp: number; since: string } | null;
}

const H = 3_600_000;
const D = 86_400_000;

function medianBig(values: bigint[]): bigint | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)]!;
}

/** Observed milliseconds within [from, to]. */
function coveredMs(points: { t: number }[], from: number, to: number, maxGapMs: number): number {
  let covered = 0;
  for (let i = 0; i < points.length; i++) {
    const start = points[i]!.t;
    const next = points[i + 1]?.t ?? to;
    const end = Math.min(next, start + maxGapMs, to);
    const s = Math.max(start, from);
    if (end > s) covered += end - s;
  }
  return covered;
}

export function priceHistory(
  input: {
    currentPaise: bigint | number;
    /** When the current price was observed (the offer's observedAt). */
    currentObservedAt: Date;
    snapshots: Observation[];
    /** The product's launch date, when known. */
    launchDate?: Date | null;
  },
  now: Date = new Date(),
  options: Partial<HistoryOptions> = {},
): PriceHistoryStats {
  const o = { ...DEFAULT_HISTORY_OPTIONS, ...options };
  const current = bigPaise(input.currentPaise);
  const nowMs = now.getTime();
  const maxGap = o.maxGapHours * H;
  const pts = [
    ...input.snapshots.map((s) => ({
      t: s.observedAt.getTime(),
      p: bigPaise(s.sellingPricePaise),
    })),
    { t: input.currentObservedAt.getTime(), p: current },
  ]
    .filter((x) => x.t <= nowMs)
    .sort((a, b) => a.t - b.t);
  const firstT = pts[0]?.t ?? null;

  const windows: WindowStats[] = o.windowsDays.map((days) => {
    const from = nowMs - days * D;
    const inWin = pts.filter((x) => x.t >= from);
    // A point just before the window still tells the price at its start.
    const before = [...pts].reverse().find((x) => x.t < from);
    const coverPts = before ? [before, ...inWin] : inWin;
    const coverage = Math.min(
      10_000,
      Math.floor((coveredMs(coverPts, from, nowMs, maxGap) * 10_000) / (days * D)),
    );
    if (!inWin.length) {
      return {
        days,
        observations: 0,
        lowestPaise: null,
        lowestObservedAt: null,
        highestPaise: null,
        averagePaise: null,
        coverageBp: coverage,
        currentIsLowest: false,
      };
    }
    let low = inWin[0]!;
    let high = inWin[0]!.p;
    let sum = 0n;
    for (const x of inWin) {
      if (x.p < low.p || (x.p === low.p && x.t > low.t)) low = x;
      if (x.p > high) high = x.p;
      sum += x.p;
    }
    return {
      days,
      observations: inWin.length,
      lowestPaise: paiseFromBig(low.p),
      lowestObservedAt: new Date(low.t).toISOString(),
      highestPaise: paiseFromBig(high),
      averagePaise: paiseFromBig(sum / BigInt(inWin.length)),
      coverageBp: coverage,
      currentIsLowest: current <= low.p,
    };
  });

  const longest = windows.reduce<WindowStats | undefined>(
    (a, w) => (!a || w.days > a.days ? w : a),
    undefined,
  );
  const w30 = windows.find((w) => w.days === 30);

  // Previous distinct price.
  let prev: { t: number; p: bigint } | null = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]!.p !== current) {
      prev = pts[i]!;
      break;
    }
  }
  const changeFromPreviousBp = prev ? signedRatioBp(current - prev.p, prev.p) : null;
  const avg30 = w30?.averagePaise == null ? null : BigInt(w30.averagePaise);
  const changeVs30 = avg30 !== null && avg30 > 0n ? signedRatioBp(current - avg30, avg30) : null;

  const span30 = pts.filter((x) => x.t >= nowMs - 30 * D);
  const spanDays = span30.length ? (span30[span30.length - 1]!.t - span30[0]!.t) / D : 0;
  let trend: PriceTrend = "INSUFFICIENT_DATA";
  if (changeVs30 !== null && span30.length >= 3 && spanDays >= 7) {
    trend =
      changeVs30 <= -o.trendThresholdBp
        ? "FALLING"
        : changeVs30 >= o.trendThresholdBp
          ? "RISING"
          : "STABLE";
  }

  // Lowest claims.
  let lowestClaim: LowestClaim = { kind: "NONE", days: null, text: null };
  const launch = input.launchDate?.getTime() ?? null;
  if (launch !== null && firstT !== null && firstT <= launch + o.launchGraceDays * D) {
    const since = Math.max(launch, firstT);
    const allCover =
      nowMs > since ? (coveredMs(pts, since, nowMs, maxGap) * 10_000) / (nowMs - since) : 0;
    if (allCover >= 9_999 && pts.every((x) => current <= x.p)) {
      lowestClaim = {
        kind: "ALL_TIME_LOW",
        days: null,
        text: "Lowest price observed on this marketplace since launch",
      };
    }
  }
  if (lowestClaim.kind === "NONE") {
    const ok = windows
      .filter((w) => w.coverageBp >= o.minCoverageBp && w.currentIsLowest)
      .sort((a, b) => b.days - a.days)[0];
    if (ok) {
      lowestClaim = {
        kind: "LOWEST_IN_WINDOW",
        days: ok.days,
        text: `Lowest observed price in the last ${ok.days} days`,
      };
    }
  }

  // Recent drop: current price vs the median of the 30 days before it began.
  let currentSince = pts.length ? pts[pts.length - 1]!.t : input.currentObservedAt.getTime();
  for (let i = pts.length - 1; i >= 0 && pts[i]!.p === current; i--) currentSince = pts[i]!.t;
  const prior = pts.filter((x) => x.t < currentSince && x.t >= currentSince - 30 * D);
  let recentDrop: PriceHistoryStats["recentDrop"] = null;
  const priorSpan = prior.length ? (prior[prior.length - 1]!.t - prior[0]!.t) / D : 0;
  const ref = medianBig(prior.map((x) => x.p));
  // The reference must have held for days (≥ 2 observations over ≥ 3 days), so a
  // short price spike can't manufacture a "drop".
  if (ref !== null && prior.length >= 2 && priorSpan >= 3 && current < ref) {
    recentDrop = {
      referencePaise: paiseFromBig(ref),
      dropPaise: paiseFromBig(ref - current),
      dropBp: signedRatioBp(ref - current, ref),
      since: new Date(currentSince).toISOString(),
    };
  }

  return {
    currentPaise: paiseFromBig(current),
    firstObservedAt: firstT === null ? null : new Date(firstT).toISOString(),
    observations: pts.length,
    windows,
    historicalAveragePaise: longest?.averagePaise ?? null,
    previousPricePaise: prev ? paiseFromBig(prev.p) : null,
    previousObservedAt: prev ? new Date(prev.t).toISOString() : null,
    changeFromPreviousBp,
    changeVs30DayAverageBp: changeVs30,
    trend,
    lowestClaim,
    recentDrop,
  };
}
