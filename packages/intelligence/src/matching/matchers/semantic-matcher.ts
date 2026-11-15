/**
 * Optional semantic fallback (pgvector). Only consulted when no stronger
 * matcher produced a reviewable candidate; its score is capped below the
 * review/auto-merge boundary of identifiers, so it can at most suggest a
 * candidate for manual review — never merge.
 *
 * Embeddings live in `matching.product_embeddings` (vector(256), HNSW cosine
 * index), outside the Prisma-managed schema. The embedding model is
 * pluggable (`EmbeddingProvider`). `LexicalHashEmbedder` is a deterministic,
 * dependency-free stand-in (feature hashing of words and character trigrams):
 * it is NOT a learned semantic model and is labelled as such everywhere.
 */
import { createHash } from "node:crypto";
import { normalizeText } from "@dealmind/catalog";
import type { CandidateHit, Db } from "./types.js";

export const EMBEDDING_DIMENSIONS = 256;

export interface EmbeddingProvider {
  /** Recorded with every stored vector; vectors from different models are never compared. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

function hashIndex(feature: string): { index: number; sign: number } {
  const h = createHash("sha256").update(feature).digest();
  return { index: h.readUInt16BE(0) % EMBEDDING_DIMENSIONS, sign: h[2]! & 1 ? 1 : -1 };
}

export class LexicalHashEmbedder implements EmbeddingProvider {
  readonly model = "lexical-hash-v1";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      const t = normalizeText(text);
      const words = t.split(" ").filter(Boolean);
      const features = [
        ...words.map((w) => `w:${w}`),
        ...words.flatMap((w) => {
          const p = ` ${w} `;
          return Array.from(
            { length: Math.max(0, p.length - 2) },
            (_, i) => `c:${p.slice(i, i + 3)}`,
          );
        }),
      ];
      for (const f of features) {
        const { index, sign } = hashIndex(f);
        v[index] = (v[index] ?? 0) + sign * (f.startsWith("w:") ? 2 : 1);
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

const vectorLiteral = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(",")}]`;

export async function embeddingsAvailable(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM pg_tables WHERE schemaname = 'matching' AND tablename = 'product_embeddings'`;
  return rows.length > 0;
}

export async function storeEmbedding(
  db: Db,
  productId: string,
  model: string,
  vector: number[],
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO matching.product_embeddings (product_id, model, embedding, updated_at)
    VALUES (${productId}::uuid, ${model}, ${vectorLiteral(vector)}::vector, now())
    ON CONFLICT (product_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, updated_at = now()`;
}

export async function findSemantic(
  db: Db,
  vector: number[],
  model: string,
  brandKey: string,
  opts: { minSimilarity: number; limit: number },
): Promise<CandidateHit[]> {
  const rows = await db.$queryRaw<{ id: string; similarity: number }[]>`
    SELECT p.id, (1 - (e.embedding <=> ${vectorLiteral(vector)}::vector))::float8 AS similarity
    FROM matching.product_embeddings e
    JOIN "Product" p ON p.id = e.product_id
    WHERE e.model = ${model} AND p."isActive"
      AND lower(regexp_replace(p.brand, '[^a-zA-Z0-9]', '', 'g')) = ${brandKey}
    ORDER BY e.embedding <=> ${vectorLiteral(vector)}::vector
    LIMIT ${opts.limit}`;
  return rows
    .filter((r) => r.similarity >= opts.minSimilarity)
    .map((r) => ({ productId: r.id, matcher: "semantic" as const, similarity: r.similarity }));
}
