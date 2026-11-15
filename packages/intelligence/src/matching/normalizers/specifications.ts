/**
 * Category-aware specification extraction and comparison.
 *
 * Variant attributes (RAM, storage, capacity, colour) come from the catalog
 * normalizer (`canonicalAttributes`, which also builds variant keys). This
 * module adds product-identity specifications that titles carry (processor,
 * GPU, display size, resolution, panel, energy rating, model year) and the
 * category profiles that decide which attributes are critical and at which
 * level (product vs variant).
 */
import { canonicalAttributes, normalizeColour, normalizeText } from "@dealmind/catalog";

export type SpecValue = string | number;
export type Specs = Record<string, SpecValue>;

export interface Processor {
  vendor: "intel" | "amd" | "apple" | "qualcomm" | "mediatek" | "samsung";
  /** e.g. "i5", "ultra 7", "ryzen 5", "m3", "8 gen 3", "dimensity". */
  tier: string;
  /** Intel/AMD generation number when stated ("13th gen", or derived from the model code). */
  gen?: number;
  /** Model code, e.g. "1335u", "7530u", "7200". */
  model?: string;
  /** Apple/Qualcomm qualifiers: "pro", "max", "ultra", "s". */
  qualifier?: string;
}

export function parseProcessor(text: string): Processor | null {
  const t = normalizeText(text);
  let m: RegExpExecArray | null;
  if (
    (m = /\bcore\s*(?:i\s*)?(i[3579])\s*(\d{4,5}[a-z]{0,2})?/.exec(t)) ||
    (m = /\b(i[3579])\s*(\d{4,5}[a-z]{0,2})\b/.exec(t))
  ) {
    const model = m[2];
    const genMatch = /(\d{1,2})(?:th|st|nd|rd)\s*gen/.exec(t);
    const gen = genMatch
      ? Number(genMatch[1])
      : model
        ? Number(model.length === 5 ? model.slice(0, 2) : model.slice(0, 1))
        : undefined;
    return { vendor: "intel", tier: m[1]!, ...(gen ? { gen } : {}), ...(model ? { model } : {}) };
  }
  if ((m = /\bcore\s*ultra\s*([579])\s*(\d{3}[a-z]{0,2})?/.exec(t))) {
    return { vendor: "intel", tier: `ultra ${m[1]}`, ...(m[2] ? { model: m[2] } : {}) };
  }
  if ((m = /\bryzen\s*([3579])\s*(\d{4}[a-z]{0,2})?/.exec(t))) {
    const model = m[2];
    return {
      vendor: "amd",
      tier: `ryzen ${m[1]}`,
      ...(model ? { model, gen: Number(model.slice(0, 1)) } : {}),
    };
  }
  if (
    (m = /\b(?:apple\s*)?\bm([1-4])\b\s*(pro|max|ultra)?/.exec(t)) &&
    /\b(apple|macbook|imac|mac)\b|chip/.test(t)
  ) {
    return { vendor: "apple", tier: `m${m[1]}`, ...(m[2] ? { qualifier: m[2] } : {}) };
  }
  if ((m = /\bsnapdragon\s*(\d)\s*(s)?\s*(?:gen\s*(\d))?/.exec(t))) {
    return {
      vendor: "qualcomm",
      tier: `${m[1]}${m[3] ? ` gen ${m[3]}` : ""}`,
      ...(m[2] ? { qualifier: "s" } : {}),
    };
  }
  if ((m = /\bdimensity\s*(\d{3,4})/.exec(t)))
    return { vendor: "mediatek", tier: "dimensity", model: m[1]! };
  if ((m = /\bexynos\s*(\d{4})/.exec(t)))
    return { vendor: "samsung", tier: "exynos", model: m[1]! };
  return null;
}

/** Fields present on both sides that differ (absent fields can't conflict). */
export function processorConflicts(a: Processor, b: Processor): string[] {
  const out: string[] = [];
  for (const k of ["vendor", "tier", "gen", "model", "qualifier"] as const) {
    if (a[k] !== undefined && b[k] !== undefined && String(a[k]) !== String(b[k])) out.push(k);
  }
  return out;
}

function parseDisplayInch(t: string): number | undefined {
  const inch = /(\d{1,3}(?:\.\d{1,2})?)\s*(?:-\s*)?(?:inch(?:es)?|in\b|"|”|'')/.exec(t);
  if (inch) return Number(inch[1]);
  const cm = /(\d{2,3})\s*cm\b/.exec(t);
  // Indian TV listings: "139 cm (55 inch)"; cm alone → convert, rounded to whole inches.
  return cm ? Math.round(Number(cm[1]) / 2.54) : undefined;
}

function parseResolution(t: string): string | undefined {
  if (/\b8k\b/.test(t)) return "8k";
  if (/\b(4k|uhd|ultra hd|2160p)\b/.test(t)) return "4k";
  if (/\b(qhd|wqhd|1440p|2k)\b/.test(t)) return "qhd";
  if (/\b(full hd|fhd|1080p)\b/.test(t)) return "fhd";
  if (/\b(hd ready|720p)\b/.test(t)) return "hd";
  return undefined;
}

function parsePanel(t: string): string | undefined {
  for (const [re, v] of [
    [/\bneo qled\b/, "neo qled"],
    [/\b(mini led|miniled)\b/, "mini led"],
    [/\b(oled|amoled)\b/, "oled"],
    [/\bqled\b/, "qled"],
    [/\bnanocell\b/, "nanocell"],
    [/\bled\b/, "led"],
    [/\b(lcd|ips)\b/, "lcd"],
  ] as const) {
    if (re.test(t)) return v;
  }
  return undefined;
}

function parseGpu(t: string): string | undefined {
  const m =
    /\b(rtx|gtx)\s*(\d{4})\s*(ti)?\b/.exec(t) ?? /\bradeon\s*(rx)\s*(\d{4})\s*(xt)?\b/.exec(t);
  if (m) return `${m[1]} ${m[2]}${m[3] ? ` ${m[3]}` : ""}`;
  if (/\b(integrated|iris xe|uhd graphics|intel graphics|arc graphics)\b/.test(t))
    return "integrated";
  return undefined;
}

/**
 * All specifications we can read deterministically: variant attributes from the
 * catalog normalizer plus product-identity specs. Explicit attributes win.
 */
export function extractSpecs(
  title: string,
  attributes: Record<string, unknown> = {},
  specifications: Record<string, unknown> = {},
  categorySlug?: string | null,
): Specs {
  const specText = Object.entries(specifications)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(" , ");
  const t = normalizeText(`${title} , ${specText}`);
  // Variant attributes (incl. colour from the title) exactly as the catalog stores them.
  const out: Specs = { ...canonicalAttributes(title, attributes, categorySlug) };
  const processor = parseProcessor(`${title} ${specText}`);
  if (processor) out.processor = JSON.stringify(processor);
  const display = parseDisplayInch(`${title} ${specText}`.toLowerCase());
  if (display !== undefined && display >= 5 && display <= 120) out.display_inch = display;
  const resolution = parseResolution(t);
  if (resolution) out.resolution = resolution;
  const panel = parsePanel(t);
  if (panel) out.panel = panel;
  const gpu = parseGpu(t);
  if (gpu) out.gpu = gpu;
  const stars = /(\d)\s*star\b/.exec(t);
  if (stars) out.energy_rating = Number(stars[1]);
  const year = /\b(20[12]\d)\b/.exec(t);
  if (year) out.model_year = Number(year[1]);
  if (/\b5g\b/.test(t)) out.connectivity = "5g";
  else if (/\b4g\b|\blte\b/.test(t)) out.connectivity = "4g";
  return out;
}

// ── Category profiles ──────────────────────────────────────────────────────

export type CategoryProfileName = "phone" | "laptop" | "tv" | "appliance" | "apparel" | "default";

export interface CategoryProfile {
  name: CategoryProfileName;
  /** A difference here means a DIFFERENT PRODUCT (never merged). */
  product: string[];
  /** A difference here means a different variant of the same product. */
  variant: string[];
}

export const PROFILES: Record<CategoryProfileName, CategoryProfile> = {
  phone: {
    name: "phone",
    product: ["connectivity", "processor", "model_year"],
    variant: ["ram_gb", "storage_gb", "capacity_gb", "color"],
  },
  laptop: {
    name: "laptop",
    product: ["processor", "gpu", "display_inch", "model_year"],
    variant: ["ram_gb", "storage_gb", "capacity_gb", "color"],
  },
  tv: {
    name: "tv",
    product: ["display_inch", "resolution", "panel", "model_year"],
    variant: ["color"],
  },
  appliance: {
    name: "appliance",
    product: ["capacity_l", "capacity_kg", "capacity_ton", "energy_rating", "model_year"],
    variant: ["color"],
  },
  apparel: { name: "apparel", product: [], variant: ["size", "color"] },
  default: {
    name: "default",
    product: [
      "processor",
      "gpu",
      "display_inch",
      "resolution",
      "panel",
      "energy_rating",
      "model_year",
      "connectivity",
    ],
    variant: [
      "ram_gb",
      "storage_gb",
      "capacity_gb",
      "capacity_l",
      "capacity_kg",
      "capacity_ton",
      "size",
      "color",
    ],
  },
};

const CATEGORY_TO_PROFILE: Record<string, CategoryProfileName> = {
  smartphones: "phone",
  tablets: "phone",
  wearables: "phone",
  laptops: "laptop",
  televisions: "tv",
  refrigerators: "appliance",
  "washing-machines": "appliance",
  "air-conditioners": "appliance",
  "kitchen-appliances": "appliance",
  "home-appliances": "appliance",
  footwear: "apparel",
  "mens-clothing": "apparel",
  "womens-clothing": "apparel",
  fashion: "apparel",
};

/** Profile from the category slug, else inferred conservatively from the specs. */
export function profileFor(categorySlug: string | null | undefined, specs: Specs): CategoryProfile {
  const byCategory = categorySlug ? CATEGORY_TO_PROFILE[categorySlug] : undefined;
  if (byCategory) return PROFILES[byCategory];
  // No category: infer only from unambiguous signals, else the strict default
  // (which treats every identity attribute as critical).
  const proc =
    typeof specs.processor === "string" ? (JSON.parse(specs.processor) as Processor) : null;
  const display = typeof specs.display_inch === "number" ? specs.display_inch : 0;
  if (proc && ["intel", "amd", "apple"].includes(proc.vendor) && display >= 10)
    return PROFILES.laptop;
  if (display >= 24 && (specs.resolution !== undefined || specs.panel !== undefined))
    return PROFILES.tv;
  if (["capacity_l", "capacity_kg", "capacity_ton"].some((k) => specs[k] !== undefined))
    return PROFILES.appliance;
  return PROFILES.default;
}

export interface AttributeComparison {
  attribute: string;
  a: SpecValue;
  b: SpecValue;
  level: "product" | "variant";
  /** "equal" | "different" | "family" (colour: different names, same family). */
  relation: "equal" | "different" | "family";
}

function equalValues(key: string, a: SpecValue, b: SpecValue): "equal" | "different" | "family" {
  if (key === "processor") {
    return processorConflicts(
      JSON.parse(String(a)) as Processor,
      JSON.parse(String(b)) as Processor,
    ).length
      ? "different"
      : "equal";
  }
  if (key === "color") {
    const ca = normalizeColour(String(a));
    const cb = normalizeColour(String(b));
    if (ca && cb && ca.key === cb.key) return "equal";
    if (ca?.family && ca.family === cb?.family) return "family";
    return "different";
  }
  if (typeof a === "number" || typeof b === "number")
    return Number(a) === Number(b) ? "equal" : "different";
  return normalizeText(String(a)) === normalizeText(String(b)) ? "equal" : "different";
}

/** Compares the attributes of the profile present on BOTH sides. */
export function compareSpecs(a: Specs, b: Specs, profile: CategoryProfile): AttributeComparison[] {
  const out: AttributeComparison[] = [];
  for (const [level, keys] of [
    ["product", profile.product],
    ["variant", profile.variant],
  ] as const) {
    for (const key of keys) {
      const va = a[key];
      const vb = b[key];
      if (va === undefined || vb === undefined) continue;
      out.push({ attribute: key, a: va, b: vb, level, relation: equalValues(key, va, vb) });
    }
  }
  return out;
}
