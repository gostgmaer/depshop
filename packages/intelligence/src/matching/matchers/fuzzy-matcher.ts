/**
 * pg_trgm fuzzy candidates: GIN trigram index on Product.normalizedName,
 * same brand only, bounded. Similarity is a candidate signal — never enough
 * on its own to merge (the scorer caps it below auto-merge).
 */
import type { CandidateHit, Db } from "./types.js";

export async function findFuzzy(
  db: Db,
  normalizedName: string,
  brandKey: string,
  opts: { minSimilarity: number; limit: number },
): Promise<CandidateHit[]> {
  const rows = await db.$queryRaw<{ id: string; similarity: number }[]>`
    SELECT id, similarity("normalizedName", ${normalizedName})::float8 AS similarity
    FROM "Product"
    WHERE "isActive" AND "normalizedName" % ${normalizedName}
      AND lower(regexp_replace(brand, '[^a-zA-Z0-9]', '', 'g')) = ${brandKey}
    ORDER BY similarity DESC, id
    LIMIT ${opts.limit}`;
  return rows
    .filter((r) => r.similarity >= opts.minSimilarity)
    .map((r) => ({ productId: r.id, matcher: "fuzzy" as const, similarity: r.similarity }));
}
