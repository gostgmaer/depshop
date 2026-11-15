/** GTIN/EAN/UPC: unique indexes on ProductVariant.gtin and Product.gtin/ean/upc. */
import type { CandidateHit, Db } from "./types.js";

export async function findByIdentifiers(db: Db, forms: string[]): Promise<CandidateHit[]> {
  if (!forms.length) return [];
  const [variants, products] = await Promise.all([
    db.productVariant.findMany({ where: { gtin: { in: forms } }, select: { productId: true } }),
    db.product.findMany({
      where: { OR: [{ gtin: { in: forms } }, { ean: { in: forms } }, { upc: { in: forms } }] },
      select: { id: true },
    }),
  ]);
  return [
    ...variants.map((v) => ({ productId: v.productId, matcher: "gtin" as const })),
    ...products.map((p) => ({ productId: p.id, matcher: "gtin" as const })),
  ];
}
