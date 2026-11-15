/**
 * Product matching / deduplication — the engine (identifier → model number →
 * normalized title → pg_trgm, with variant/generation guards) lives in
 * @dealmind/catalog; the importer applies it while persisting offers.
 */
export {
  CatalogImporter,
  CatalogMatcher,
  DEFAULT_THRESHOLDS,
  SourceNotActiveError,
} from "@dealmind/catalog";
export type {
  ImportSummary,
  ListingOutcome,
  MatchDecision,
  MatchThresholds,
} from "@dealmind/catalog";
