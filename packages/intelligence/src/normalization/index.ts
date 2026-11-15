/**
 * Product normalization — the implementation lives in @dealmind/catalog
 * (used by the importer); re-exported here so callers depend on one
 * intelligence boundary instead of duplicating logic.
 */
export {
  analyzeTitle,
  brandKey,
  canonicalAttributes,
  classifyBarcode,
  modelKey,
  normalizeBrand,
  normalizeColour,
  normalizeListing,
  normalizeText,
  parseApplianceCapacity,
  parseCapacityGb,
  parseMemoryFromTitle,
  productDisplayName,
  sourceListingSchema,
  variantKeyOf,
} from "@dealmind/catalog";
export type { NormalizedListing, SourceListing, VariantAttributes } from "@dealmind/catalog";
