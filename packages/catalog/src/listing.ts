/**
 * The contract a connector/feed hands to the importer, and its normalized form.
 * Everything here must come from the source; the importer never fills gaps.
 */
import { z } from "zod";
import {
  type Identifiers,
  type VariantAttributes,
  analyzeTitle,
  brandKey,
  canonicalAttributes,
  classifyBarcode,
  cleanDisplay,
  modelKey,
  normalizeBrand,
  normalizeColour,
  productDisplayName,
  variantKeyOf,
} from "./normalize.js";

const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "Only http(s) URLs are allowed");

export const sourceListingSchema = z
  .object({
    /** The source's own stable id for the listing (ASIN, FSN, SKU…). */
    externalId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(3).max(500),
    productUrl: httpUrl,
    brand: z.string().trim().min(1).max(100),
    modelNumber: z.string().trim().min(1).max(100).optional(),
    /** Barcode as published (GTIN-8/12/13/14); invalid check digits are dropped. */
    barcode: z.string().trim().max(20).optional(),
    categorySlug: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(5000).optional(),
    manufacturer: z.string().trim().max(200).optional(),
    imageUrl: httpUrl.optional(),
    launchDate: z.coerce.date().optional(),
    /** Product-level specifications exactly as published by the source. */
    specifications: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
    /** Variant-level attributes as published (colour, RAM, storage, size…). */
    attributes: z.record(z.union([z.string().max(100), z.number()])).default({}),
    sku: z.string().trim().max(100).optional(),
    sellerName: z.string().trim().max(200).optional(),
    sellingPricePaise: paise,
    mrpPaise: paise.optional(),
    shippingPaise: paise.optional(),
    stockStatus: z
      .enum(["IN_STOCK", "LIMITED", "OUT_OF_STOCK", "PREORDER", "UNKNOWN"])
      .default("UNKNOWN"),
    currency: z.literal("INR").default("INR"),
    offerConditions: z.record(z.unknown()).default({}),
    sourceUpdatedAt: z.coerce.date().optional(),
  })
  .strict();
export type SourceListing = z.input<typeof sourceListingSchema>;
export type ValidListing = z.output<typeof sourceListingSchema>;

export interface NormalizedListing {
  raw: ValidListing;
  brand: string;
  brandKey: string;
  /** Product display name (variant parenthetical removed, casing preserved). */
  name: string;
  normalizedName: string;
  discriminators: string[];
  modelNumber: string | null;
  modelKey: string | null;
  /** brandKey:modelKey — deterministic product key when a model number is known. */
  fingerprint: string | null;
  identifiers: Identifiers;
  attributes: VariantAttributes;
  variantKey: string;
}

export function normalizeListing(listing: ValidListing): NormalizedListing {
  const brand = normalizeBrand(listing.brand);
  const bKey = brandKey(brand);
  const mKey = modelKey(listing.modelNumber);
  const attributes = canonicalAttributes(listing.title, listing.attributes);
  const colour = normalizeColour(typeof attributes.color === "string" ? attributes.color : null);
  // The model number itself is not a discriminator (titles include it inconsistently).
  const titleForAnalysis = listing.modelNumber
    ? listing.title.split(listing.modelNumber).join(" ")
    : listing.title;
  const { normalizedName, discriminators } = analyzeTitle(titleForAnalysis, brand, colour?.name);
  return {
    raw: listing,
    brand,
    brandKey: bKey,
    name: productDisplayName(listing.title),
    normalizedName,
    discriminators,
    modelNumber: listing.modelNumber ? cleanDisplay(listing.modelNumber) : null,
    modelKey: mKey,
    fingerprint: mKey ? `${bKey}:${mKey}` : null,
    identifiers: classifyBarcode(listing.barcode),
    attributes,
    variantKey: variantKeyOf(attributes),
  };
}
