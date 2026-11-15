/**
 * Display formatting. Money stays integer paise everywhere; conversion to a
 * display string happens only here (via the shared formatter).
 */
import { formatBasisPoints, formatPaise } from "@dealmind/shared";

export function rupees(paise: number | null | undefined): string {
  return paise === null || paise === undefined ? "—" : formatPaise(paise);
}

export function percent(bp: number | null | undefined): string {
  return bp === null || bp === undefined ? "—" : formatBasisPoints(bp);
}

const rtf = new Intl.RelativeTimeFormat("en-IN", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "5 minutes ago", "yesterday" (relative to `now`). */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" });
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
export const formatDate = (iso: string) => dateOnly.format(new Date(iso));

export const STOCK_LABEL: Record<string, string> = {
  IN_STOCK: "In stock",
  LIMITED: "Limited stock",
  OUT_OF_STOCK: "Out of stock",
  PREORDER: "Pre-order",
  UNKNOWN: "Availability unknown",
};

/** "ram_gb: 8" → "8 GB RAM" for common canonical keys; otherwise "Key: value". */
export function specLabel(key: string, value: unknown): string {
  const v = String(value);
  switch (key) {
    case "ram_gb":
      return `${v} GB RAM`;
    case "storage_gb":
      return Number(v) >= 1024 ? `${Number(v) / 1024} TB` : `${v} GB`;
    case "capacity_gb":
      return `${v} GB`;
    case "capacity_l":
      return `${v} L`;
    case "capacity_kg":
      return `${v} kg`;
    case "capacity_ton":
      return `${v} ton`;
    case "color":
      return v.replace(/\b\w/g, (c) => c.toUpperCase());
    case "size":
      return `Size ${v.toUpperCase()}`;
    default:
      return `${key.replace(/_/g, " ")}: ${v}`;
  }
}

/** Visible variant attributes in a stable order. */
export function variantSummary(attributes: Record<string, unknown>): string[] {
  const order = [
    "ram_gb",
    "storage_gb",
    "capacity_gb",
    "capacity_l",
    "capacity_kg",
    "capacity_ton",
    "size",
    "color",
  ];
  return order
    .filter((k) => attributes[k] !== undefined && attributes[k] !== null)
    .map((k) => specLabel(k, attributes[k]));
}
