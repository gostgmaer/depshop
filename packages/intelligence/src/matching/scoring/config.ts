/**
 * Matching configuration. Scores are basis points (0–10000 = 0.00–100.00).
 * The thresholds are starting points, validated against the labelled dataset
 * (src/matching/test/labeled-pairs.ts); tune them with that dataset, not by feel.
 */
export interface MatchingConfig {
  /** ≥ veryHigh → VERY_HIGH confidence. */
  veryHighBp: number;
  /** ≥ high → HIGH: applied automatically. */
  highBp: number;
  /** ≥ review (and < high) → MANUAL_REVIEW. Below → do not merge. */
  reviewBp: number;
  /** Minimum pg_trgm similarity for a fuzzy candidate (0–1). */
  minTrigramSimilarity: number;
  /** Minimum cosine similarity for a semantic candidate (0–1). */
  minSemanticSimilarity: number;
  /** Candidate limits (pre-filtering; never all-vs-all). */
  maxFuzzyCandidates: number;
  maxSemanticCandidates: number;
  maxCandidates: number;
  /** Base scores of the evidence kinds. */
  evidence: {
    identifier: number;
    mpn: number;
    model: number;
    titleCorroborated: number;
    titleUncorroborated: number;
    /** Fuzzy: floor + similarity × span, never above `fuzzyCap`. */
    fuzzyFloor: number;
    fuzzySpan: number;
    fuzzyCap: number;
    semanticFloor: number;
    semanticSpan: number;
    semanticCap: number;
  };
}

export const ENGINE_VERSION = "match-v2.0";

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  veryHighBp: 9_800,
  highBp: 9_000,
  reviewBp: 7_500,
  minTrigramSimilarity: 0.45,
  minSemanticSimilarity: 0.8,
  maxFuzzyCandidates: 10,
  maxSemanticCandidates: 5,
  maxCandidates: 25,
  evidence: {
    identifier: 10_000,
    mpn: 9_900,
    model: 9_600,
    titleCorroborated: 9_200,
    titleUncorroborated: 8_200,
    fuzzyFloor: 5_500,
    fuzzySpan: 3_500,
    // Title similarity alone can never reach the auto-merge band.
    fuzzyCap: 8_900,
    semanticFloor: 5_000,
    semanticSpan: 3_500,
    semanticCap: 8_500,
  },
};

export function validateConfig(c: MatchingConfig): MatchingConfig {
  if (!(c.reviewBp <= c.highBp && c.highBp <= c.veryHighBp && c.veryHighBp <= 10_000)) {
    throw new Error("Matching thresholds must satisfy review ≤ high ≤ veryHigh ≤ 10000");
  }
  if (c.evidence.fuzzyCap >= c.highBp || c.evidence.semanticCap >= c.highBp) {
    throw new Error("Fuzzy/semantic caps must stay below the auto-merge threshold");
  }
  return c;
}

export type ConfidenceLevel = "VERY_HIGH" | "HIGH" | "REVIEW" | "LOW";

export function confidenceOf(scoreBp: number, c: MatchingConfig): ConfidenceLevel {
  if (scoreBp >= c.veryHighBp) return "VERY_HIGH";
  if (scoreBp >= c.highBp) return "HIGH";
  if (scoreBp >= c.reviewBp) return "REVIEW";
  return "LOW";
}
