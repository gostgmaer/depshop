/** Manufacturer part number: ProductVariant.mpn (stored as its normalized key, indexed). */
import type { CandidateHit, Db } from "./types.js";

export async function findByMpn(db: Db, mpnKey: string | null): Promise<CandidateHit[]> {
  if (!mpnKey) return [];
  const rows = await db.productVariant.findMany({
    where: { mpn: mpnKey },
    select: { productId: true },
    take: 10,
  });
  return rows.map((r) => ({ productId: r.productId, matcher: "mpn" as const }));
}
