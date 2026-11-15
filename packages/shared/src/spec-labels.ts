/**
 * Display labels for canonical specification keys (as stored by the catalog
 * normalizer: `ram_gb`, `capacity_ton`, `screen_size_inch`…). Unknown keys are
 * humanized, so a new category's specifications appear without code changes.
 */
const KNOWN: Record<string, string> = {
  ram_gb: "RAM",
  storage_gb: "Storage",
  capacity_gb: "Capacity",
  capacity_l: "Capacity",
  capacity_kg: "Capacity",
  capacity_ton: "Capacity",
  color: "Colour",
  color_family: "Colour family",
  gpu: "GPU",
  os: "Operating system",
  ssd_gb: "SSD",
  refresh_rate_hz: "Refresh rate",
  screen_size_inch: "Screen size",
  display_size_inch: "Display size",
  battery_mah: "Battery",
  energy_rating: "Energy rating",
};

const UNIT: Record<string, string> = {
  gb: "GB",
  tb: "TB",
  l: "L",
  kg: "kg",
  ton: "ton",
  hz: "Hz",
  inch: "inch",
  mah: "mAh",
  mp: "MP",
  w: "W",
};

/** The unit implied by a key's suffix (`ram_gb` → "GB"), if any. */
export function specUnit(key: string): string | null {
  const suffix = key.split("_").at(-1) ?? "";
  return key.includes("_") ? (UNIT[suffix] ?? null) : null;
}

export function specLabel(key: string): string {
  const known = KNOWN[key];
  if (known) return known;
  const unit = specUnit(key);
  const words = (unit ? key.split("_").slice(0, -1) : key.split("_")).join(" ");
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return unit ? `${text} (${unit})` : text;
}

/** "8 GB", "1 TB", "1.5 ton", or the text value unchanged. */
export function specValueLabel(key: string, value: unknown): string {
  const unit = specUnit(key);
  if (unit === "GB" && typeof value === "number" && value >= 1024 && value % 1024 === 0)
    return `${value / 1024} TB`;
  if (unit && (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))))
    return `${String(value)} ${unit}`;
  return String(value);
}

/**
 * The text a search spec filter sends for a stored value. Capacities in GB are
 * sent with their unit so the catalog normalizer parses them back exactly.
 */
export function specFilterValue(key: string, value: unknown): string {
  return specUnit(key) === "GB" && typeof value === "number" ? `${value} GB` : String(value);
}
