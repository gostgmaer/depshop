/**
 * Duplicate detection inside the catalog, plus the (manual-only) product merge.
 *
 *  - Duplicate products: candidate pairs from indexed pre-filters (same brand
 *    with equal normalized name, or pg_trgm-similar names, bounded per product),
 *    scored product-to-product. Pairs that would merge or need review are
 *    reported and audited as MANUAL_REVIEW; products are NEVER merged
 *    automatically.
 *  - Duplicate variants: variants of one product whose canonical attributes
 *    produce the same variant key.
 *  - Duplicate offers: offers of one source sharing a canonical URL.
 */
import { variantKeyOf } from "@dealmind/catalog";
import type { Prisma, PrismaClient } from "@dealmind/db";
import type { MatchingEngine } from "../engine.js";
import type { PairResult } from "../scoring/score.js";
import { recordAudit } from "./importer.js";

type Tx = Prisma.TransactionClient;

export interface DuplicateProductPair {
  productAId: string;
  productBId: string;
  result: PairResult;
  auditId: string | null;
}

export async function findDuplicateProducts(
  prisma: PrismaClient,
  engine: MatchingEngine,
  opts: { limit?: number; brand?: string; record?: boolean } = {},
): Promise<DuplicateProductPair[]> {
  const limit = opts.limit ?? 200;
  const brandFilter = opts.brand ?? null;
  // Bounded self-join: for each product, its 5 most similar same-brand products.
  const pairs = await prisma.$queryRaw<{ a: string; b: string }[]>`
    SELECT p.id AS a, q.id AS b
    FROM "Product" p
    CROSS JOIN LATERAL (
      SELECT q.id FROM "Product" q
      WHERE q.id > p.id AND q."isActive" AND lower(q.brand) = lower(p.brand)
        AND (q."normalizedName" = p."normalizedName" OR q."normalizedName" % p."normalizedName")
      ORDER BY similarity(q."normalizedName", p."normalizedName") DESC
      LIMIT 5
    ) q
    WHERE p."isActive" AND (${brandFilter}::text IS NULL OR lower(p.brand) = lower(${brandFilter}::text))
    LIMIT ${limit}`;
  const out: DuplicateProductPair[] = [];
  for (const { a, b } of pairs) {
    const result = await engine.compareProducts(prisma, a, b);
    if (!result || result.decision === "NO_MATCH") continue;
    let auditId: string | null = null;
    if (opts.record) {
      auditId = await recordAudit(
        prisma,
        {
          subject: "PRODUCT_PAIR",
          origin: "DUPLICATE_SCAN",
          productAId: a,
          candidateProductId: b,
          scoreBp: result.scoreBp,
          // Products are never merged automatically, whatever the score.
          decision: "MANUAL_REVIEW",
          method: result.method,
          evidence: { ...result.evidence, scoreWouldAutoMerge: result.decision === "AUTO_MERGE" },
          conflicts: result.conflicts,
        },
        engine.config,
      );
    }
    out.push({ productAId: a, productBId: b, result, auditId });
  }
  return out;
}

export async function findDuplicateVariants(db: PrismaClient | Tx, productId?: string) {
  const variants = await db.productVariant.findMany({
    where: productId ? { productId } : {},
    select: { id: true, productId: true, variantKey: true, attributes: true },
    orderBy: [{ productId: "asc" }, { createdAt: "asc" }],
  });
  const groups = new Map<string, string[]>();
  for (const v of variants) {
    const key = `${v.productId}|${variantKeyOf((v.attributes ?? {}) as Record<string, string | number>)}`;
    groups.set(key, [...(groups.get(key) ?? []), v.id]);
  }
  return [...groups]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ productId: key.split("|")[0]!, variantIds: ids }));
}

export async function findDuplicateOffers(db: PrismaClient | Tx) {
  return db.$queryRaw<{ sourceId: string; canonicalUrl: string; offerIds: string[] }[]>`
    SELECT "sourceId", "canonicalUrl", array_agg(id ORDER BY "firstSeenAt") AS "offerIds"
    FROM "ProductOffer"
    WHERE "canonicalUrl" IS NOT NULL
    GROUP BY "sourceId", "canonicalUrl"
    HAVING count(*) > 1`;
}

/**
 * Merges product `mergeId` into `keepId` in one transaction (manual review only).
 * Variants with the same key are folded (offers, watchlist items and alerts
 * re-pointed; per-user uniqueness preserved by dropping exact duplicates);
 * other variants move with their offers (composite FK cascades productId).
 */
export async function mergeProducts(
  tx: Tx,
  keepId: string,
  mergeId: string,
): Promise<{ movedVariants: number; foldedVariants: number }> {
  if (keepId === mergeId) throw new Error("Cannot merge a product into itself");
  await tx.$executeRaw`SELECT 1 FROM "Product" WHERE id IN (${keepId}::uuid, ${mergeId}::uuid) FOR UPDATE`;
  const keep = await tx.productVariant.findMany({ where: { productId: keepId } });
  const merge = await tx.productVariant.findMany({ where: { productId: mergeId } });
  const keepByKey = new Map(keep.map((v) => [v.variantKey, v.id]));
  let moved = 0;
  let folded = 0;
  for (const v of merge) {
    const target = keepByKey.get(v.variantKey);
    if (!target) {
      await tx.productVariant.update({ where: { id: v.id }, data: { productId: keepId } });
      moved += 1;
      continue;
    }
    await tx.productOffer.updateMany({
      where: { variantId: v.id },
      data: { variantId: target, productId: keepId },
    });
    // Watchlist items/alerts: keep one per (watchlist|user, variant); drop exact duplicates.
    await tx.$executeRaw`
      DELETE FROM "WatchlistItem" w WHERE w."variantId" = ${v.id}::uuid
        AND EXISTS (SELECT 1 FROM "WatchlistItem" x WHERE x."watchlistId" = w."watchlistId" AND x."variantId" = ${target}::uuid)`;
    await tx.$executeRaw`UPDATE "WatchlistItem" SET "variantId" = ${target}::uuid WHERE "variantId" = ${v.id}::uuid`;
    await tx.$executeRaw`
      DELETE FROM "PriceAlert" a WHERE a."variantId" = ${v.id}::uuid
        AND EXISTS (SELECT 1 FROM "PriceAlert" x WHERE x."userId" = a."userId" AND x."variantId" = ${target}::uuid
                    AND x."sourceId" IS NOT DISTINCT FROM a."sourceId")`;
    await tx.$executeRaw`UPDATE "PriceAlert" SET "variantId" = ${target}::uuid WHERE "variantId" = ${v.id}::uuid`;
    await tx.productVariant.delete({ where: { id: v.id } });
    folded += 1;
  }
  await tx.productOffer.updateMany({ where: { productId: mergeId }, data: { productId: keepId } });
  await tx.productMatchReview.updateMany({
    where: { candidateProductId: mergeId },
    data: { candidateProductId: keepId },
  });
  const k = await tx.product.findUniqueOrThrow({ where: { id: keepId } });
  const m = await tx.product.findUniqueOrThrow({ where: { id: mergeId } });
  await tx.product.delete({ where: { id: mergeId } });
  // Keep identifiers the kept product lacks (unique columns: only after the delete).
  const fill: Prisma.ProductUpdateInput = {};
  for (const f of [
    "gtin",
    "ean",
    "upc",
    "modelNumber",
    "fingerprint",
    "description",
    "manufacturer",
    "imageUrl",
    "launchDate",
  ] as const) {
    if (k[f] == null && m[f] != null) (fill as Record<string, unknown>)[f] = m[f];
  }
  if (Object.keys(fill).length) await tx.product.update({ where: { id: keepId }, data: fill });
  return { movedVariants: moved, foldedVariants: folded };
}
