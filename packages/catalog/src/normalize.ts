/**
 * Deterministic listing normalization. Pure functions only: no I/O, no LLM,
 * nothing invented. Every output is derived from text the source provided;
 * when a value cannot be parsed it is left out (never guessed).
 */

// ── Text ──────────────────────────────────────────────────────────────────

/** NFKC, lower-case, "&" → "and", punctuation → spaces, collapsed whitespace. */
export function normalizeText(input: string): string {
  return (
    input
      .replace(/[™®©]/g, "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[’'`]/g, "")
      .replace(/[^\p{L}\p{N}.+]+/gu, " ")
      .replace(/(?<!\d)\.|\.(?!\d)/g, " ") // keep decimal points (e.g. 1.5 ton) only
      // "S25+" / "Note 13 Pro+" name a different line: "+" after a token that is
      // not followed by a capacity means "plus" ("8GB+128GB" stays a separator).
      .replace(/([\p{L}\p{N}])\+(?!\s*\d+(?:\.\d+)?\s*(?:gb|tb|mb)\b)/gu, "$1 plus ")
      .replace(/\+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Trims and collapses whitespace in a display string (original casing kept). */
export function cleanDisplay(input: string): string {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim();
}

// ── Brands ────────────────────────────────────────────────────────────────

/**
 * Known aliases → canonical brand. Keys are `brandKey()` forms. Sub-brands
 * sold under their own name (Redmi, POCO, iQOO) stay separate brands.
 */
const BRAND_ALIASES: Record<string, string> = {
  apple: "Apple",
  appleinc: "Apple",
  samsung: "Samsung",
  samsungelectronics: "Samsung",
  samsungindia: "Samsung",
  xiaomi: "Xiaomi",
  mi: "Xiaomi",
  redmi: "Redmi",
  poco: "POCO",
  oneplus: "OnePlus",
  realme: "realme",
  oppo: "OPPO",
  vivo: "vivo",
  iqoo: "iQOO",
  motorola: "Motorola",
  moto: "Motorola",
  nothing: "Nothing",
  google: "Google",
  googlepixel: "Google",
  hp: "HP",
  hewlettpackard: "HP",
  dell: "Dell",
  lenovo: "Lenovo",
  asus: "ASUS",
  acer: "Acer",
  msi: "MSI",
  sony: "Sony",
  lg: "LG",
  lgelectronics: "LG",
  boat: "boAt",
  jbl: "JBL",
  bose: "Bose",
  philips: "Philips",
  whirlpool: "Whirlpool",
  godrej: "Godrej",
  haier: "Haier",
  voltas: "Voltas",
  bajaj: "Bajaj",
  prestige: "Prestige",
  tcl: "TCL",
  nike: "Nike",
  adidas: "adidas",
  puma: "PUMA",
  levis: "Levi's",
  allensolly: "Allen Solly",
  lakme: "Lakmé",
  maybelline: "Maybelline",
  maybellinenewyork: "Maybelline",
};

/** Lower-case alphanumeric key used to compare brands. */
export function brandKey(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Canonical display brand; unknown brands keep their published spelling. */
export function normalizeBrand(raw: string): string {
  const key = brandKey(raw);
  return BRAND_ALIASES[key] ?? cleanDisplay(raw);
}

// ── Identifiers ───────────────────────────────────────────────────────────

/** Upper-case alphanumeric model key: "SM-S921B/DS" → "SMS921BDS". */
export function modelKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return key.length >= 2 ? key : null;
}

function gtinCheckDigitValid(digits: string): boolean {
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    // Weights alternate 3,1 from the rightmost body digit.
    const weight = (body.length - i) % 2 === 1 ? 3 : 1;
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

export interface Identifiers {
  gtin?: string; // GTIN-8 or GTIN-14
  ean?: string; // EAN-13
  upc?: string; // UPC-A (12)
}

/**
 * Validates a barcode (length + check digit) and files it under the right
 * column. Invalid codes are dropped rather than stored.
 */
export function classifyBarcode(raw: string | null | undefined): Identifiers {
  if (!raw) return {};
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || !gtinCheckDigitValid(digits)) return {};
  switch (digits.length) {
    case 13:
      return { ean: digits };
    case 12:
      return { upc: digits };
    case 8:
    case 14:
      return { gtin: digits };
    default:
      return {};
  }
}

/** Every equivalent form of an identifier set, for lookups (UPC-A ≡ EAN-13 with a leading 0). */
export function identifierForms(ids: Identifiers): {
  gtin: string[];
  ean: string[];
  upc: string[];
} {
  const gtin = new Set<string>();
  const ean = new Set<string>();
  const upc = new Set<string>();
  if (ids.gtin) {
    gtin.add(ids.gtin);
    if (ids.gtin.length === 14 && ids.gtin.startsWith("0")) ean.add(ids.gtin.slice(1));
  }
  if (ids.ean) {
    ean.add(ids.ean);
    gtin.add(`0${ids.ean}`);
    if (ids.ean.startsWith("0")) upc.add(ids.ean.slice(1));
  }
  if (ids.upc) {
    upc.add(ids.upc);
    ean.add(`0${ids.upc}`);
    gtin.add(`00${ids.upc}`);
  }
  return { gtin: [...gtin], ean: [...ean], upc: [...upc] };
}

// ── Units ─────────────────────────────────────────────────────────────────

const SIZE_UNITS: Record<string, number> = { mb: 1 / 1024, gb: 1, tb: 1024 };

/** "8 GB" / "8GB" / "1TB" / "512 MB" → gigabytes; null when unparseable. */
export function parseCapacityGb(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(mb|gb|tb)\b/i.exec(text);
  if (!m) return null;
  const unit = SIZE_UNITS[m[2]!.toLowerCase()]!;
  return Math.round(Number(m[1]) * unit * 1000) / 1000;
}

// ── Colour ────────────────────────────────────────────────────────────────

const COLOR_FAMILIES = [
  "black",
  "white",
  "silver",
  "grey",
  "gold",
  "blue",
  "green",
  "red",
  "pink",
  "purple",
  "yellow",
  "orange",
  "brown",
  "beige",
  "titanium",
] as const;
const COLOR_SYNONYMS: Record<string, (typeof COLOR_FAMILIES)[number]> = {
  gray: "grey",
  graphite: "grey",
  midnight: "black",
  onyx: "black",
  jet: "black",
  obsidian: "black",
  starlight: "white",
  cream: "beige",
  navy: "blue",
  teal: "green",
  mint: "green",
  violet: "purple",
  lavender: "purple",
  rose: "pink",
  maroon: "red",
  crimson: "red",
};

export interface Colour {
  /** Published colour name, preserved (e.g. "Phantom Black"). */
  name: string;
  /** Normalized name used in variant keys (e.g. "phantom-black"). */
  key: string;
  /** Coarse family for filtering (e.g. "black"); null when unknown. */
  family: string | null;
}

export function normalizeColour(raw: string | null | undefined): Colour | null {
  if (!raw) return null;
  const name = cleanDisplay(raw);
  // Spelling variants share a key ("Space Gray" = "Space Grey").
  const SPELLING: Record<string, string> = { gray: "grey", colour: "color" };
  const words = normalizeText(name)
    .split(" ")
    .filter(Boolean)
    .map((w) => SPELLING[w] ?? w);
  if (words.length === 0) return null;
  const familyOf = (w: string) =>
    (COLOR_FAMILIES as readonly string[]).includes(w) ? w : (COLOR_SYNONYMS[w] ?? null);
  const families = words.map(familyOf).filter((f): f is NonNullable<typeof f> => f !== null);
  // A real hue wins over a finish ("Titanium Blue" / "Blue Titanium" → blue).
  const family = families.find((f) => f !== "titanium") ?? families[0] ?? null;
  // Order-insensitive key: "Titanium Blue" and "Blue Titanium" are one colour.
  return { name, key: [...words].sort().join("-"), family };
}

function isColourWord(word: string): boolean {
  return (COLOR_FAMILIES as readonly string[]).includes(word) || word in COLOR_SYNONYMS;
}

// ── Variant attributes ────────────────────────────────────────────────────

export type AttributeValue = string | number;
export type VariantAttributes = Record<string, AttributeValue>;

/**
 * RAM / storage published in a title, e.g. "8GB RAM, 256GB Storage",
 * "(8GB+128GB)", "8 GB / 256 GB", "12GB RAM 512GB ROM". Only explicit
 * patterns are accepted; ambiguous single capacities are not assigned.
 */
export function parseMemoryFromTitle(title: string): { ram_gb?: number; storage_gb?: number } {
  const t = title.replace(/\s+/g, " ");
  const out: { ram_gb?: number; storage_gb?: number } = {};
  const ram = /(\d+(?:\.\d+)?)\s*(gb|tb)\s*(?:lpddr\d*x?\s*|ddr\d\s*)?ram\b/i.exec(t);
  if (ram) out.ram_gb = parseCapacityGb(`${ram[1]}${ram[2]}`) ?? undefined;
  const storage =
    /(\d+(?:\.\d+)?)\s*(gb|tb)\s*(?:storage|rom|ssd|internal(?: storage)?|hdd|emmc)\b/i.exec(t);
  if (storage) out.storage_gb = parseCapacityGb(`${storage[1]}${storage[2]}`) ?? undefined;
  if (out.ram_gb === undefined && out.storage_gb === undefined) {
    // "8GB+128GB" / "8 GB / 128 GB": RAM first, then storage.
    const pair = /(\d+)\s*(gb)\s*[+/]\s*(\d+)\s*(gb|tb)\b/i.exec(t);
    if (pair) {
      out.ram_gb = parseCapacityGb(`${pair[1]}${pair[2]}`) ?? undefined;
      out.storage_gb = parseCapacityGb(`${pair[3]}${pair[4]}`) ?? undefined;
    }
  }
  if (out.ram_gb !== undefined && out.storage_gb === undefined) {
    // "12GB RAM, 256GB" — RAM is labelled; exactly one other unlabelled
    // capacity (≥ 16 GB, not itself RAM) is the storage. More than one → ambiguous.
    const others = [
      ...t.matchAll(/(\d+(?:\.\d+)?)\s*(gb|tb)\b(?!\s*(?:lpddr\d*x?\s*|ddr\d\s*)?ram)/gi),
    ]
      .map((m) => parseCapacityGb(`${m[1]}${m[2]}`))
      .filter((gb): gb is number => gb !== null && gb >= 16);
    if (others.length === 1) out.storage_gb = others[0];
  }
  return out;
}

/** Appliance capacities that identify different variants (never merged). */
export function parseApplianceCapacity(title: string): VariantAttributes {
  const out: VariantAttributes = {};
  const litres = /(\d+(?:\.\d+)?)\s*(?:l|ltr|litres?|liters?)\b/i.exec(title);
  if (litres) out.capacity_l = Number(litres[1]);
  const kg = /(\d+(?:\.\d+)?)\s*kg\b/i.exec(title);
  if (kg) out.capacity_kg = Number(kg[1]);
  const ton = /(\d+(?:\.\d+)?)\s*ton\b/i.exec(title);
  if (ton) out.capacity_ton = Number(ton[1]);
  return out;
}

const ATTRIBUTE_ALIASES: Record<string, string> = {
  ram: "ram_gb",
  memory: "ram_gb",
  storage: "storage_gb",
  rom: "storage_gb",
  internal_storage: "storage_gb",
  ssd: "storage_gb",
  colour: "color",
  size: "size",
};
const CAPACITY_KEYS = new Set(["ram_gb", "storage_gb"]);

/**
 * Canonical variant attributes from source-provided attributes plus explicit
 * title patterns. Provided attributes win over title parsing.
 */
/** A title segment that is only a colour name ("… - Black", "(Navy, 12GB, …)"). */
export function colourFromTitle(title: string): string | undefined {
  for (const segment of title.split(/[(),\-–|/]+/)) {
    const s = segment.trim();
    if (!s || /\d/.test(s) || s.split(/\s+/).length > 3) continue;
    if (normalizeColour(s)?.family) return s;
  }
  return undefined;
}

/** Categories where a single unlabelled capacity in a title is the storage. */
const STORAGE_CATEGORIES = new Set(["smartphones", "tablets", "wearables"]);

export function canonicalAttributes(
  title: string,
  provided: Record<string, unknown> = {},
  categorySlug?: string | null,
): VariantAttributes {
  const attrs: VariantAttributes = {
    ...parseApplianceCapacity(title),
    ...parseMemoryFromTitle(title),
  };
  for (const [rawKey, rawValue] of Object.entries(provided)) {
    if (rawValue == null || rawValue === "") continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number") continue; // scalars only
    const k = normalizeText(rawKey).replace(/ /g, "_");
    const key = ATTRIBUTE_ALIASES[k] ?? k;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue;
    if (CAPACITY_KEYS.has(key)) {
      const gb = typeof rawValue === "number" ? rawValue : parseCapacityGb(String(rawValue));
      if (gb != null) attrs[key] = gb;
      continue;
    }
    if (key === "color") {
      const colour = normalizeColour(String(rawValue));
      if (colour) {
        attrs.color = colour.name;
        if (colour.family) attrs.color_family = colour.family;
      }
      continue;
    }
    if (typeof rawValue === "number" || typeof rawValue === "string") {
      attrs[key] = typeof rawValue === "string" ? cleanDisplay(rawValue) : rawValue;
    }
  }
  if (attrs.color === undefined) {
    // Colour stated only in the title ("(Midnight Black, 8GB RAM, …)", "… - Black")
    // must be part of the variant, or Black and Blue would share a variant key.
    const colour = normalizeColour(colourFromTitle(title));
    if (colour?.family) {
      attrs.color = colour.name;
      attrs.color_family = colour.family;
    }
  }
  if (attrs.ram_gb === undefined && attrs.storage_gb === undefined) {
    // A single unlabelled capacity ("Apple iPhone 15 (128 GB)") must never be
    // dropped, or 128 GB and 256 GB variants would share a key. In phone-like
    // categories it is the storage; elsewhere it stays a generic capacity.
    const caps = [...title.matchAll(/(\d+(?:\.\d+)?)\s*(gb|tb)\b/gi)]
      .map((m) => parseCapacityGb(`${m[1]}${m[2]}`))
      .filter((gb): gb is number => gb !== null);
    if (caps.length && new Set(caps).size === 1) {
      if (categorySlug && STORAGE_CATEGORIES.has(categorySlug)) attrs.storage_gb = caps[0]!;
      else attrs.capacity_gb = caps[0]!;
    }
  }
  return attrs;
}

/** Stable key: sorted `key=value` pairs, colour by normalized name. */
export function variantKeyOf(attrs: VariantAttributes): string {
  const parts: string[] = [];
  for (const key of Object.keys(attrs).sort()) {
    if (key === "color_family") continue; // derived from color
    const value = attrs[key]!;
    const v =
      key === "color"
        ? (normalizeColour(String(value))?.key ?? "")
        : normalizeText(String(value)).replace(/ /g, "-");
    if (v) parts.push(`${key}=${v}`);
  }
  return parts.length ? parts.join("|") : "default";
}

// ── Titles ────────────────────────────────────────────────────────────────

/** Tokens that distinguish product lines/generations and must never differ in a match. */
const QUALIFIERS = new Set([
  "pro",
  "max",
  "plus",
  "ultra",
  "lite",
  "mini",
  "fe",
  "neo",
  "prime",
  "air",
  "edge",
  "fold",
  "flip",
  "slim",
  "4g",
  "5g",
  "oled",
  "qled",
  "gen",
]);

/** Words that describe listings, not products. */
const NOISE = new Set([
  "with",
  "and",
  "the",
  "for",
  "new",
  "latest",
  "smartphone",
  "mobile",
  "phone",
  "dual",
  "sim",
  "ram",
  "rom",
  "storage",
  "internal",
  "expandable",
  "upto",
  "up",
  "to",
  "inr",
]);

const MEMORY_TOKEN = /^\d+(?:\.\d+)?(?:mb|gb|tb)$/;
const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:l|ltr|kg|ton)$/;

export interface TitleAnalysis {
  /** Normalized product-level name: no colour, memory or capacity tokens. */
  normalizedName: string;
  /** Generation numbers and line qualifiers, sorted (e.g. ["15", "pro"]). */
  discriminators: string[];
}

/**
 * Removes variant-level tokens (colour, RAM/storage, capacities) and listing
 * noise so that variants of one product share a normalized name, while
 * keeping generation numbers and line qualifiers ("15", "pro", "5g").
 */
export function analyzeTitle(title: string, brand: string, colour?: string | null): TitleAnalysis {
  // Join "8 GB" → "8gb" and "1.5 Ton" → "1.5ton" so units travel with numbers.
  // The trailing variant parenthetical ("(Marble Grey, 8GB, 128GB)") is variant-level.
  const text = normalizeText(productDisplayName(title)).replace(
    /(\d+(?:\.\d+)?) (mb|gb|tb|l|ltr|kg|ton|inch|inches|cm)\b/g,
    "$1$2",
  );
  const brandWords = new Set(normalizeText(brand).split(" "));
  const colourWords = new Set(colour ? normalizeText(colour).split(" ") : []);
  const kept: string[] = [];
  const discriminators = new Set<string>();
  for (const word of text.split(" ")) {
    if (!word || NOISE.has(word)) continue;
    if (MEMORY_TOKEN.test(word) || UNIT_TOKEN.test(word)) continue;
    if (colourWords.has(word) || isColourWord(word)) continue;
    if (brandWords.has(word)) continue;
    kept.push(word);
    // Any token with a digit ("15", "s24", "55inch", "2024") or a line qualifier.
    if (QUALIFIERS.has(word) || /\d/.test(word)) {
      discriminators.add(word);
    }
  }
  return {
    normalizedName: [normalizeText(brand), ...kept].join(" ").trim(),
    discriminators: [...discriminators].sort(),
  };
}

/**
 * Product-level display name: drops variant descriptors, e.g.
 * "Galaxy S24 (Onyx Black, 8GB, 256GB)" → "Galaxy S24", "iPhone 15 (128 GB) - Black" → "iPhone 15".
 */
export function productDisplayName(title: string): string {
  const original = cleanDisplay(title);
  // Bracketed groups that describe a variant (memory, storage, colour).
  let name = original.replace(
    /\s*[([][^)\]]*(?:\d\s*(?:gb|tb)|ram|storage|colou?r|\bsize\b)[^)\]]*[)\]]/gi,
    "",
  );
  // A trailing "- Black" / ", Midnight Blue" made only of colour words.
  name = name.replace(/\s*[-,|]\s*([\p{L} ]+)$/u, (m, tail: string) => {
    const words = normalizeText(tail).split(" ").filter(Boolean);
    return words.length > 0 && words.length <= 3 && words.some(isColourWord) ? "" : m;
  });
  // A trailing bracket naming only a colour: "(Onyx Black)".
  name = name.replace(/\s*[([]([^)\]]+)[)\]]$/u, (m, inner: string) => {
    const words = normalizeText(inner).split(" ").filter(Boolean);
    return words.length <= 3 && words.some(isColourWord) ? "" : m;
  });
  return name.trim() || original;
}

/** Discriminators of an already-normalized name (same rule as analyzeTitle). */
export function discriminatorsOfName(normalizedName: string): string[] {
  return [
    ...new Set(normalizedName.split(" ").filter((w) => QUALIFIERS.has(w) || /\d/.test(w))),
  ].sort();
}

/** Every discriminator present in one set but not the other. */
export function discriminatorConflicts(a: readonly string[], b: readonly string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  return [...new Set([...a.filter((x) => !sb.has(x)), ...b.filter((x) => !sa.has(x))])].sort();
}

/** Attribute keys whose values differ between two variant attribute sets (both present). */
export function attributeConflicts(a: VariantAttributes, b: VariantAttributes): string[] {
  return Object.keys(a)
    .filter((k) => k in b && String(a[k]).toLowerCase() !== String(b[k]).toLowerCase())
    .sort();
}

// ── URLs ──────────────────────────────────────────────────────────────────

/** Query parameters that only track attribution (never identify a listing). */
const TRACKING_PARAMS =
  /^(utm_[a-z]+|aff[a-z_]*|affid|affextparam\d*|tag|ref|ref_|gclid|fbclid|cmpid|campaign|source|srsltid|_encoding|psc)$/i;

/**
 * Canonical form of a product URL for duplicate-offer detection: lower-case
 * host without "www.", no fragment, no tracking parameters, remaining
 * parameters sorted, no trailing slash. Identity parameters (e.g. pid) stay.
 */
export function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `https://${host}${path}${query}`;
}
