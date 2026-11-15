/**
 * Title normalization. Text cleaning, display names and generation tokens are
 * the catalog normalizer's (re-exported, never duplicated); this module adds a
 * pg_trgm-compatible trigram similarity so scores computed in TypeScript (batch
 * and pair comparisons) equal those PostgreSQL would compute.
 */
export {
  analyzeTitle,
  discriminatorConflicts,
  discriminatorsOfName,
  normalizeText,
  productDisplayName,
} from "@dealmind/catalog";

/**
 * Trigrams exactly as pg_trgm builds them: lower-case, words split on
 * non-alphanumerics, each word padded with two leading and one trailing space.
 */
export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm `similarity()`: |A ∩ B| / |A ∪ B| over trigram sets (0–1). */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}
