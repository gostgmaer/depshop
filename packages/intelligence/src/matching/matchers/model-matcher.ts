/** Brand + normalized model number: Product.fingerprint ("brandkey:MODELKEY", unique index). */
import type { CandidateHit, Db } from "./types.js";

export async function findByModel(db: Db, fingerprint: string | null): Promise<CandidateHit[]> {
  if (!fingerprint) return [];
  const p = await db.product.findUnique({ where: { fingerprint }, select: { id: true } });
  return p ? [{ productId: p.id, matcher: "model" }] : [];
}

/** Exact normalized title within the same brand (trigram GIN supports equality). */
export async function findByTitle(
  db: Db,
  normalizedName: string,
  brandKey: string,
): Promise<CandidateHit[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Product"
    WHERE "normalizedName" = ${normalizedName} AND "isActive"
      AND lower(regexp_replace(brand, '[^a-zA-Z0-9]', '', 'g')) = ${brandKey}
    LIMIT 10`;
  return rows.map((r) => ({ productId: r.id, matcher: "title" as const }));
}
