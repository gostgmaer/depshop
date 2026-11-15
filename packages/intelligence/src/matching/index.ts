/**
 * Product matching & deduplication engine (independent of LangGraph and LLMs).
 * See docs/MATCHING.md.
 */
export * from "./normalizers/title.js";
export * from "./normalizers/brand.js";
export * from "./normalizers/model.js";
export * from "./normalizers/identifiers.js";
export * from "./normalizers/specifications.js";
export * from "./matchers/variant-matcher.js";
export {
  LexicalHashEmbedder,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
} from "./matchers/semantic-matcher.js";
export * from "./scoring/config.js";
export * from "./scoring/score.js";
export * from "./subject.js";
export * from "./engine.js";
export * from "./deduplication/importer.js";
export * from "./deduplication/duplicates.js";
export * from "./review/review-service.js";
export * from "./service.js";
export * from "./schemas/api.js";
