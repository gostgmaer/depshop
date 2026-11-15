export * from "./pricing/index.js";
export * from "./ranking/index.js";
export * from "./matching/index.js";
export * from "./sample-data/sample-data.js";
export {
  canonicalAttributes,
  classifyBarcode,
  normalizeColour,
  normalizeListing,
  parseApplianceCapacity,
  parseCapacityGb,
  parseMemoryFromTitle,
  sourceListingSchema,
  variantKeyOf,
} from "@dealmind/catalog";
export type { NormalizedListing, SourceListing, VariantAttributes } from "@dealmind/catalog";
