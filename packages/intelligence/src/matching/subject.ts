/**
 * Match subjects: the normalized view of a listing or of a catalog product
 * that the scorer compares. Built only from normalizer output.
 */
import { type NormalizedListing, brandKey } from "@dealmind/catalog";
import { allIdentifierForms, identifierForms } from "./normalizers/identifiers.js";
import { modelKey } from "./normalizers/model.js";
import {
  type CategoryProfile,
  PROFILES,
  type Specs,
  extractSpecs,
  profileFor,
} from "./normalizers/specifications.js";
import { analyzeTitle, discriminatorsOfName } from "./normalizers/title.js";

export interface VariantSubject {
  id: string | null;
  variantKey: string | null;
  /** Canonical variant attributes (catalog normalizer). */
  attributes: Specs;
  identifiers: string[];
  mpnKey: string | null;
}

export interface Subject {
  /** Product id for catalog products; null for incoming listings. */
  productId: string | null;
  label: string;
  brand: string;
  brandKey: string;
  modelKey: string | null;
  normalizedName: string;
  discriminators: string[];
  categorySlug: string | null;
  profile: CategoryProfile;
  /** Product-level specs (identity attributes). */
  productSpecs: Specs;
  /** A listing has exactly one variant; a product has all of its variants. */
  variants: VariantSubject[];
  /** Product-level identifiers (Product.gtin/ean/upc), all forms. */
  productIdentifiers: string[];
}

const VARIANT_KEYS = new Set([
  "capacity_gb",
  "ram_gb",
  "storage_gb",
  "color",
  "color_family",
  "size",
  "capacity_l",
  "capacity_kg",
  "capacity_ton",
]);

function splitSpecs(specs: Specs, profile: CategoryProfile): { product: Specs; variant: Specs } {
  const product: Specs = {};
  const variant: Specs = {};
  for (const [k, v] of Object.entries(specs)) {
    if (profile.product.includes(k)) product[k] = v;
    else if (profile.variant.includes(k) || VARIANT_KEYS.has(k)) variant[k] = v;
    else product[k] = v;
  }
  return { product, variant };
}

export function listingSubject(n: NormalizedListing, categorySlug?: string | null): Subject {
  const specs = extractSpecs(
    n.raw.title,
    n.raw.attributes,
    n.raw.specifications,
    categorySlug ?? n.raw.categorySlug,
  );
  const category = categorySlug ?? n.raw.categorySlug ?? null;
  const profile = profileFor(category, specs);
  const { product, variant } = splitSpecs(specs, profile);
  const forms = allIdentifierForms(identifierForms(n.identifiers));
  return {
    productId: null,
    label: n.raw.title,
    brand: n.brand,
    brandKey: n.brandKey,
    modelKey: n.modelKey,
    normalizedName: n.normalizedName,
    discriminators: n.discriminators,
    categorySlug: category,
    profile,
    productSpecs: product,
    variants: [
      {
        id: null,
        variantKey: n.variantKey,
        attributes: variant,
        identifiers: forms,
        mpnKey: n.mpnKey,
      },
    ],
    productIdentifiers: [],
  };
}

export interface ProductRow {
  id: string;
  name: string;
  normalizedName: string;
  brand: string;
  modelNumber: string | null;
  gtin: string | null;
  ean: string | null;
  upc: string | null;
  specifications: unknown;
  category: { slug: string } | null;
  variants: {
    id: string;
    variantKey: string;
    attributes: unknown;
    gtin: string | null;
    mpn: string | null;
  }[];
}

export function productSubject(p: ProductRow): Subject {
  const specs = extractSpecs(
    p.name,
    {},
    (p.specifications ?? {}) as Record<string, unknown>,
    p.category?.slug,
  );
  const variants: VariantSubject[] = p.variants.map((v) => {
    const attrs = (v.attributes ?? {}) as Specs;
    const forms = v.gtin ? allIdentifierForms(identifierForms(gtinKind(v.gtin))) : [];
    return {
      id: v.id,
      variantKey: v.variantKey,
      attributes: attrs,
      identifiers: forms,
      mpnKey: modelKey(v.mpn),
    };
  });
  const profile = profileFor(p.category?.slug ?? null, {
    ...specs,
    ...(variants[0]?.attributes ?? {}),
  });
  const { product } = splitSpecs(specs, profile);
  // Product-level attributes stored on every variant identically (e.g. capacity
  // for appliances) are product identity; if variants disagree they're variant-level.
  for (const key of profile.product) {
    if (product[key] !== undefined) continue;
    const values = new Set(
      variants
        .map((v) => v.attributes[key])
        .filter((x) => x !== undefined)
        .map(String),
    );
    if (values.size === 1 && variants.every((v) => v.attributes[key] !== undefined)) {
      product[key] = variants[0]!.attributes[key]!;
    }
  }
  const productIds = [p.gtin, p.ean, p.upc].filter((x): x is string => Boolean(x));
  return {
    productId: p.id,
    label: p.name,
    brand: p.brand,
    brandKey: brandKey(p.brand),
    modelKey: modelKey(p.modelNumber),
    normalizedName: p.normalizedName,
    discriminators: discriminatorsOfName(p.normalizedName),
    categorySlug: p.category?.slug ?? null,
    profile,
    productSpecs: product,
    variants,
    productIdentifiers: [
      ...new Set(productIds.flatMap((x) => allIdentifierForms(identifierForms(gtinKind(x))))),
    ],
  };
}

function gtinKind(code: string) {
  if (code.length === 13) return { ean: code };
  if (code.length === 12) return { upc: code };
  return { gtin: code };
}

/** A pair subject from a bare title (labelled-dataset tests, batch dry runs). */
export function titleSubject(
  title: string,
  brand: string,
  opts: {
    model?: string;
    mpn?: string;
    barcode?: string;
    category?: string;
    attributes?: Record<string, unknown>;
  } = {},
): Subject {
  const bKey = brandKey(brand);
  const specs = extractSpecs(title, opts.attributes ?? {}, {}, opts.category);
  const profile = opts.category ? profileFor(opts.category, specs) : PROFILES.default;
  const { product, variant } = splitSpecs(specs, profile);
  const analysis = analyzeTitle(
    opts.model ? title.split(opts.model).join(" ") : title,
    brand,
    typeof specs.color === "string" ? specs.color : null,
  );
  return {
    productId: null,
    label: title,
    brand,
    brandKey: bKey,
    modelKey: modelKey(opts.model),
    normalizedName: analysis.normalizedName,
    discriminators: analysis.discriminators,
    categorySlug: opts.category ?? null,
    profile,
    productSpecs: product,
    variants: [
      {
        id: null,
        variantKey: null,
        attributes: variant,
        identifiers: opts.barcode ? [opts.barcode] : [],
        mpnKey: modelKey(opts.mpn),
      },
    ],
    productIdentifiers: [],
  };
}
