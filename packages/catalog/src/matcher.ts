/**
 * Deterministic catalog matching. Priority:
 *   1. barcode (GTIN/EAN/UPC, any equivalent form) on a variant or product;
 *   2. brand + manufacturer model number (product fingerprint);
 *   3. brand + exact normalized name;
 *   4. brand + pg_trgm similarity of normalized names.
 * Guards: model/generation tokens and line qualifiers must agree, a different
 * model number is a hard conflict, and identifier hits whose brand differs are
 * never trusted. Anything uncertain is sent to manual review — never merged.
 * (Semantic/embedding similarity is intentionally not used yet.)
 */
import type { MatchMethod, Prisma, PrismaClient } from "@dealmind/db";
import type { NormalizedListing } from "./listing.js";
import {
  brandKey,
  discriminatorConflicts,
  discriminatorsOfName,
  identifierForms,
} from "./normalize.js";

/** Every method the decision can report (MANUAL/NEW_PRODUCT come from review or creation). */
export type MatchMethodValue = MatchMethod;

export interface MatchThresholds {
  /** Confidence (basis points) at or above which a match is applied automatically. */
  autoMatchBp: number;
  /** Confidence at or above which (but below auto) the listing goes to review. */
  reviewBp: number;
  /** Minimum pg_trgm similarity (0–1) for a fuzzy candidate to be considered. */
  minSimilarity: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  autoMatchBp: 9_200,
  reviewBp: 7_500,
  minSimilarity: 0.55,
};

export interface MatchEvidence {
  method: MatchMethodValue;
  candidateProductId?: string;
  identifier?: string;
  fingerprint?: string;
  similarity?: number;
  conflicts?: string[];
  reason: string;
  [key: string]: unknown;
}

export type MatchDecision =
  | {
      kind: "MATCH";
      productId: string;
      /** Set when the identifier pinned an exact variant. */
      variantId?: string;
      method: MatchMethodValue;
      confidence: number;
      evidence: MatchEvidence;
    }
  | {
      kind: "REVIEW";
      candidateProductId: string;
      method: MatchMethodValue;
      confidence: number;
      evidence: MatchEvidence;
    }
  | { kind: "NEW"; confidence: number; evidence: MatchEvidence };

type Db = PrismaClient | Prisma.TransactionClient;

interface Candidate {
  id: string;
  brand: string;
  normalizedName: string;
  modelNumber: string | null;
}

function modelConflict(listing: NormalizedListing, candidate: Candidate): boolean {
  if (!listing.modelKey || !candidate.modelNumber) return false;
  return candidate.modelNumber.toUpperCase().replace(/[^A-Z0-9]/g, "") !== listing.modelKey;
}

/**
 * Discriminator comparison:
 *  - equal sets → no conflict;
 *  - both sides have tokens the other lacks ("15" vs "14") → hard conflict;
 *  - only one side has extra tokens ("15" vs "15 pro") → soft (review at most).
 */
function compareDiscriminators(
  a: string[],
  b: string[],
): { hard: boolean; soft: boolean; diff: string[] } {
  const diff = discriminatorConflicts(a, b);
  if (diff.length === 0) return { hard: false, soft: false, diff };
  const onlyA = a.some((x) => !b.includes(x));
  const onlyB = b.some((x) => !a.includes(x));
  return { hard: onlyA && onlyB, soft: !(onlyA && onlyB), diff };
}

export class CatalogMatcher {
  constructor(private readonly thresholds: MatchThresholds = DEFAULT_THRESHOLDS) {
    if (!(thresholds.reviewBp <= thresholds.autoMatchBp && thresholds.autoMatchBp <= 10_000)) {
      throw new Error("Match thresholds must satisfy reviewBp <= autoMatchBp <= 10000");
    }
  }

  get config(): MatchThresholds {
    return this.thresholds;
  }

  async match(db: Db, listing: NormalizedListing): Promise<MatchDecision> {
    return (
      (await this.byIdentifier(db, listing)) ??
      (await this.byModelNumber(db, listing)) ??
      (await this.byNormalizedName(db, listing)) ??
      (await this.byFuzzyName(db, listing))
    );
  }

  /** Converts a confidence into a decision, honouring guards. */
  private decide(
    candidate: Candidate,
    listing: NormalizedListing,
    method: MatchMethodValue,
    confidence: number,
    evidence: Omit<MatchEvidence, "method" | "reason" | "candidateProductId">,
    variantId?: string,
  ): MatchDecision | null {
    const d = compareDiscriminators(
      listing.discriminators,
      discriminatorsOfName(candidate.normalizedName),
    );
    const conflicts = [...d.diff];
    if (modelConflict(listing, candidate)) conflicts.push("modelNumber");
    const base = { ...evidence, method, candidateProductId: candidate.id, conflicts };
    if (d.hard || modelConflict(listing, candidate)) {
      // Definitely a different product (e.g. another generation): not this candidate.
      return null;
    }
    const capped = d.soft ? Math.min(confidence, this.thresholds.autoMatchBp - 1) : confidence;
    if (capped >= this.thresholds.autoMatchBp) {
      return {
        kind: "MATCH",
        productId: candidate.id,
        ...(variantId ? { variantId } : {}),
        method,
        confidence: capped,
        evidence: { ...base, reason: "confidence at or above auto-match threshold" },
      };
    }
    // A one-sided line/generation difference is always uncertain: review, never merge, never duplicate silently.
    if (capped >= this.thresholds.reviewBp || d.soft) {
      return {
        kind: "REVIEW",
        candidateProductId: candidate.id,
        method,
        confidence: capped,
        evidence: {
          ...base,
          reason: d.soft
            ? "line/generation tokens differ on one side"
            : "confidence below auto-match threshold",
        },
      };
    }
    return null;
  }

  private async byIdentifier(db: Db, listing: NormalizedListing): Promise<MatchDecision | null> {
    const forms = identifierForms(listing.identifiers);
    const all = [...forms.gtin, ...forms.ean, ...forms.upc];
    if (all.length === 0) return null;
    const variant = await db.productVariant.findFirst({
      where: { gtin: { in: all } },
      include: {
        product: { select: { id: true, brand: true, normalizedName: true, modelNumber: true } },
      },
    });
    const product =
      variant?.product ??
      (await db.product.findFirst({
        where: {
          OR: [
            ...(forms.gtin.length ? [{ gtin: { in: forms.gtin } }] : []),
            ...(forms.ean.length ? [{ ean: { in: forms.ean } }] : []),
            ...(forms.upc.length ? [{ upc: { in: forms.upc } }] : []),
          ],
        },
        select: { id: true, brand: true, normalizedName: true, modelNumber: true },
      }));
    if (!product) return null;
    const identifier = all[0]!;
    if (brandKey(product.brand) !== listing.brandKey) {
      // A barcode shared across brands is a data error: never auto-merge it.
      return {
        kind: "REVIEW",
        candidateProductId: product.id,
        method: "IDENTIFIER",
        confidence: this.thresholds.reviewBp,
        evidence: {
          method: "IDENTIFIER",
          candidateProductId: product.id,
          identifier,
          conflicts: ["brand"],
          reason: "identifier matches a product of a different brand",
        },
      };
    }
    return (
      this.decide(product, listing, "IDENTIFIER", 10_000, { identifier }, variant?.id) ?? {
        kind: "REVIEW",
        candidateProductId: product.id,
        method: "IDENTIFIER",
        confidence: this.thresholds.reviewBp,
        evidence: {
          method: "IDENTIFIER",
          candidateProductId: product.id,
          identifier,
          reason: "identifier matches but model/generation tokens conflict",
        },
      }
    );
  }

  private async byModelNumber(db: Db, listing: NormalizedListing): Promise<MatchDecision | null> {
    if (!listing.fingerprint) return null;
    const product = await db.product.findUnique({
      where: { fingerprint: listing.fingerprint },
      select: { id: true, brand: true, normalizedName: true, modelNumber: true },
    });
    if (!product) return null;
    return this.decide(product, listing, "MODEL_NUMBER", 9_800, {
      fingerprint: listing.fingerprint,
    });
  }

  private async byNormalizedName(
    db: Db,
    listing: NormalizedListing,
  ): Promise<MatchDecision | null> {
    const candidates = await db.product.findMany({
      where: { normalizedName: listing.normalizedName, isActive: true },
      select: { id: true, brand: true, normalizedName: true, modelNumber: true },
      take: 5,
    });
    for (const c of candidates) {
      if (brandKey(c.brand) !== listing.brandKey) continue;
      const decision = this.decide(c, listing, "NORMALIZED_TITLE", 9_500, {});
      if (decision) return decision;
    }
    return null;
  }

  private async byFuzzyName(db: Db, listing: NormalizedListing): Promise<MatchDecision> {
    const rows = await db.$queryRaw<(Candidate & { similarity: number })[]>`
      SELECT id, brand, "normalizedName", "modelNumber",
             similarity("normalizedName", ${listing.normalizedName})::float8 AS similarity
      FROM "Product"
      WHERE "isActive" AND "normalizedName" % ${listing.normalizedName}
      ORDER BY similarity DESC
      LIMIT 10`;
    for (const row of rows) {
      if (row.similarity < this.thresholds.minSimilarity) break;
      if (brandKey(row.brand) !== listing.brandKey) continue;
      const confidence = Math.floor(row.similarity * 10_000);
      const decision = this.decide(row, listing, "FUZZY_TITLE", confidence, {
        similarity: Math.round(row.similarity * 10_000) / 10_000,
      });
      if (decision) return decision;
    }
    const best = rows[0];
    return {
      kind: "NEW",
      confidence: 10_000,
      evidence: {
        method: "NEW_PRODUCT",
        reason: "no catalog product passed identifier, model number or title matching",
        ...(best ? { bestSimilarity: Math.round(best.similarity * 10_000) / 10_000 } : {}),
      },
    };
  }
}
