/**
 * Category-aware grouping of specifications for display and comparison.
 * Keys are whatever the catalog stores (canonical keys like `ram_gb`, or a
 * marketplace's own labels like "Display"); a key is grouped by what it
 * describes, and groups are ordered by what matters most in the category.
 * Nothing is added: a group appears only if some product states a key in it.
 */
import { specLabel, specValueLabel } from "@dealmind/shared";

export interface SpecGroupDef {
  id: string;
  label: string;
  match: RegExp;
}

/** First match wins, so more specific groups come first. */
export const SPEC_GROUPS: SpecGroupDef[] = [
  { id: "performance", label: "Performance", match: /processor|chipset|cpu|soc|cores?\b|clock/ },
  { id: "graphics", label: "Graphics", match: /gpu|graphics/ },
  {
    id: "display",
    label: "Display",
    match: /display|screen|resolution|refresh|panel|hdr|brightness|nits/,
  },
  { id: "memory", label: "Memory & storage", match: /\bram\b|ram_|memory|storage|\brom\b|ssd|hdd/ },
  { id: "camera", label: "Camera", match: /camera|megapixel|_mp\b|lens|zoom/ },
  { id: "battery", label: "Battery & charging", match: /battery|mah|charging|charger/ },
  { id: "capacity", label: "Capacity", match: /capacity|_l$|_kg$|ton|litre|liter|load/ },
  { id: "energy", label: "Energy", match: /energy|star_rating|wattage|_w$|consumption|power/ },
  {
    id: "connectivity",
    label: "Connectivity",
    match: /\b5g\b|wifi|wi_fi|bluetooth|nfc|usb|hdmi|ports?\b|sim/,
  },
  {
    id: "software",
    label: "Software",
    match: /\bos\b|operating|android|ios\b|platform|smart_tv|webos|tizen|windows|macos/,
  },
  { id: "dimensions", label: "Size & weight", match: /dimension|weight|height|width|depth|size/ },
  { id: "design", label: "Design", match: /colou?r|material|finish/ },
  { id: "features", label: "Features", match: /feature|type|mode|technology/ },
];
export const OTHER_GROUP = { id: "other", label: "Other specifications" };

const CATEGORY_ORDER: [RegExp, string[]][] = [
  [/phone|mobile|tablet/, ["performance", "memory", "camera", "battery", "display", "software"]],
  [
    /laptop|notebook|computer/,
    ["performance", "memory", "graphics", "display", "battery", "software"],
  ],
  [/tele|\btv/, ["display", "software", "connectivity", "energy", "dimensions"]],
  [
    /wash|refrigerator|fridge|air[-_ ]?condition|\bac\b|appliance|microwave|dishwasher|purifier|heater|geyser/,
    ["capacity", "energy", "features", "dimensions"],
  ],
];

const norm = (key: string) =>
  key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export function groupOf(key: string): { id: string; label: string } {
  const k = norm(key);
  return SPEC_GROUPS.find((g) => g.match.test(k)) ?? OTHER_GROUP;
}

/** Group order for a category (by slug or name); unlisted groups keep the default order. */
export function groupOrder(category: string | null | undefined): string[] {
  const c = (category ?? "").toLowerCase();
  const first = CATEGORY_ORDER.find(([re]) => re.test(c))?.[1] ?? [];
  return [...first, ...SPEC_GROUPS.map((g) => g.id).filter((id) => !first.includes(id)), "other"];
}

/** A stored specification's label: canonical keys get their label, raw labels are kept. */
export function displayKey(key: string): string {
  return /^[a-z][a-z0-9_]*$/.test(key) ? specLabel(key) : key;
}

export function displayValue(key: string, value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean")
    return /^[a-z][a-z0-9_]*$/.test(key) ? specValueLabel(key, value) : String(value);
  return null; // objects/arrays are never rendered as a spec value
}

export interface SpecRow {
  key: string;
  label: string;
  values: (string | null)[];
  /** Two or more stated values that differ. */
  differs: boolean;
  /** Stated by some items but not all (never treated as equal or different). */
  partial: boolean;
}

export interface SpecGroup {
  id: string;
  label: string;
  rows: SpecRow[];
}

const comparable = (v: string) => v.toLowerCase().replace(/\s+/g, "");

/**
 * Specification rows for 1+ items, grouped and ordered for the category.
 * `items[i]` maps a key to the value item i states (variant attributes first).
 */
export function compareSpecs(
  items: Record<string, unknown>[],
  category: string | null | undefined,
): SpecGroup[] {
  const keys = new Set<string>();
  for (const it of items)
    for (const [k, v] of Object.entries(it)) if (displayValue(k, v) !== null) keys.add(k);
  // color_family duplicates color for display.
  if (keys.has("color")) keys.delete("color_family");
  const groups = new Map<string, SpecGroup>();
  for (const key of [...keys].sort((a, b) => displayKey(a).localeCompare(displayKey(b)))) {
    const g = groupOf(key);
    const values = items.map((it) => displayValue(key, it[key]));
    const stated = values.filter((v): v is string => v !== null);
    const row: SpecRow = {
      key,
      label: displayKey(key),
      values,
      differs: new Set(stated.map(comparable)).size > 1,
      partial: stated.length > 0 && stated.length < values.length,
    };
    const group = groups.get(g.id) ?? { id: g.id, label: g.label, rows: [] };
    group.rows.push(row);
    groups.set(g.id, group);
  }
  const order = groupOrder(category);
  return [...groups.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
