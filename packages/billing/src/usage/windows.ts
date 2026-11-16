/**
 * Usage windows in India Standard Time (UTC+05:30, no DST): daily metrics
 * reset at IST midnight, monthly metrics on the 1st (IST).
 */
const IST_MS = 330 * 60_000;

export type WindowKind = "day" | "month";

/** Start of the IST day or month containing `now`, as a UTC instant. */
export function windowStart(kind: WindowKind, now: Date): Date {
  const local = new Date(now.getTime() + IST_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = kind === "day" ? local.getUTCDate() : 1;
  return new Date(Date.UTC(y, m, d) - IST_MS);
}

/** When the window containing `now` ends (the next one starts). */
export function windowEnd(kind: WindowKind, now: Date): Date {
  const start = new Date(windowStart(kind, now).getTime() + IST_MS);
  const next =
    kind === "day"
      ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1)
      : Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  return new Date(next - IST_MS);
}
