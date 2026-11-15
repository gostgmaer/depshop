/**
 * MatchingEngine: finds the catalog product (and variant) an incoming listing
 * is, or decides it's new. Independent of LangGraph and of any LLM.
 *
 *   1. candidates from indexed pre-filters (identifier, MPN, brand+model,
 *      exact title, bounded pg_trgm), then — only if nothing reviewable was
 *      found — the optional semantic matcher;
 *   2. every candidate scored by `scorePair` (same code as pair/batch checks);
 *   3. best candidate decides: AUTO_MERGE (≥ high), MANUAL_REVIEW (≥ review),
 *      otherwise NEW_PRODUCT. Nothing uncertain is merged.
 */
import { type NormalizedListing } from "@dealmind/catalog";
import { findFuzzy } from "./matchers/fuzzy-matcher.js";
import { findByIdentifiers } from "./matchers/gtin-matcher.js";
import { findByModel, findByTitle } from "./matchers/model-matcher.js";
import { findByMpn } from "./matchers/mpn-matcher.js";
import {
  type EmbeddingProvider,
  embeddingsAvailable,
  findSemantic,
} from "./matchers/semantic-matcher.js";
import type { CandidateHit, Db } from "./matchers/types.js";
import { DEFAULT_MATCHING_CONFIG, type MatchingConfig, validateConfig } from "./scoring/config.js";
import { type PairResult, scorePair } from "./scoring/score.js";
import { type ProductRow, type Subject, listingSubject, productSubject } from "./subject.js";

export type EngineDecision = "AUTO_MERGE" | "MANUAL_REVIEW" | "NEW_PRODUCT";

export interface EngineResult {
  decision: EngineDecision;
  /** Best-scoring candidate (null when nothing was found). */
  best: PairResult | null;
  /** Up to 5 scored candidates, best first (explainability). */
  candidates: PairResult[];
  /** For AUTO_MERGE: target product and variant placement. */
  productId?: string;
  variantId?: string;
  newVariant?: boolean;
  matchers: Record<string, number>;
}

export const productRowInclude = {
  category: { select: { slug: true } },
  variants: { select: { id: true, variantKey: true, attributes: true, gtin: true, mpn: true } },
} as const;

const RANK = { AUTO_MERGE: 0, MANUAL_REVIEW: 1, NO_MATCH: 2 } as const;

export class MatchingEngine {
  readonly config: MatchingConfig;

  constructor(
    config: Partial<MatchingConfig> = {},
    private readonly embedder: EmbeddingProvider | null = null,
  ) {
    this.config = validateConfig({
      ...DEFAULT_MATCHING_CONFIG,
      ...config,
      evidence: { ...DEFAULT_MATCHING_CONFIG.evidence, ...(config.evidence ?? {}) },
    });
  }

  get embeddingProvider(): EmbeddingProvider | null {
    return this.embedder;
  }

  async loadProducts(db: Db, ids: string[]): Promise<ProductRow[]> {
    if (!ids.length) return [];
    return db.product.findMany({
      where: { id: { in: ids }, isActive: true },
      include: productRowInclude,
    });
  }

  async matchListing(
    db: Db,
    listing: NormalizedListing,
    categorySlug?: string | null,
  ): Promise<EngineResult> {
    const subject = listingSubject(listing, categorySlug);
    const c = this.config;
    const forms = subject.variants[0]?.identifiers ?? [];
    const hits: CandidateHit[] = (
      await Promise.all([
        findByIdentifiers(db, forms),
        findByMpn(db, subject.variants[0]?.mpnKey ?? null),
        findByModel(db, listing.fingerprint),
        findByTitle(db, subject.normalizedName, subject.brandKey),
        findFuzzy(db, subject.normalizedName, subject.brandKey, {
          minSimilarity: c.minTrigramSimilarity,
          limit: c.maxFuzzyCandidates,
        }),
      ])
    ).flat();
    let results = await this.scoreHits(db, subject, hits);

    // Semantic fallback only when nothing reviewable was found by stronger matchers.
    if (
      this.embedder &&
      !results.some((r) => r.decision !== "NO_MATCH") &&
      (await embeddingsAvailable(db))
    ) {
      const [vector] = await this.embedder.embed([`${listing.brand} ${listing.name}`]);
      const semantic = await findSemantic(db, vector!, this.embedder.model, subject.brandKey, {
        minSimilarity: c.minSemanticSimilarity,
        limit: c.maxSemanticCandidates,
      });
      if (semantic.length) {
        results = [...results, ...(await this.scoreHits(db, subject, semantic))];
        results.sort(compareResults);
      }
    }
    return this.decide(results, hits);
  }

  private async scoreHits(db: Db, subject: Subject, hits: CandidateHit[]): Promise<PairResult[]> {
    const similarity = new Map<string, number>();
    for (const h of hits)
      if (h.matcher === "semantic" && h.similarity !== undefined)
        similarity.set(h.productId, h.similarity);
    const ids = [...new Set(hits.map((h) => h.productId))].slice(0, this.config.maxCandidates);
    const products = await this.loadProducts(db, ids);
    return products
      .map((p) => {
        const sem = similarity.get(p.id);
        return scorePair(subject, productSubject(p), {
          config: this.config,
          ...(sem !== undefined ? { semanticSimilarity: sem } : {}),
        });
      })
      .sort(compareResults);
  }

  private decide(results: PairResult[], hits: CandidateHit[]): EngineResult {
    const matchers: Record<string, number> = {};
    for (const h of hits) matchers[h.matcher] = (matchers[h.matcher] ?? 0) + 1;
    const best = results[0] ?? null;
    const candidates = results.slice(0, 5);
    if (!best || best.decision === "NO_MATCH")
      return { decision: "NEW_PRODUCT", best, candidates, matchers };
    if (best.decision === "MANUAL_REVIEW")
      return { decision: "MANUAL_REVIEW", best, candidates, matchers };
    // A second candidate that is also auto-mergeable means the catalog may hold
    // duplicates: don't pick one silently.
    const rival = results[1];
    if (rival && rival.decision === "AUTO_MERGE" && rival.productB.id !== best.productB.id) {
      best.evidence.notes.push("another catalog product also matches: possible duplicate products");
      return { decision: "MANUAL_REVIEW", best, candidates, matchers };
    }
    const v = best.variant;
    return {
      decision: "AUTO_MERGE",
      best,
      candidates,
      matchers,
      productId: best.productB.id!,
      ...(v?.relation === "SAME_VARIANT" ? { variantId: v.variantId } : { newVariant: true }),
    };
  }

  /** Product-to-product comparison (duplicate detection). */
  async compareProducts(
    db: Db,
    productAId: string,
    productBId: string,
  ): Promise<PairResult | null> {
    const [a, b] = await Promise.all([
      this.loadProducts(db, [productAId]),
      this.loadProducts(db, [productBId]),
    ]);
    if (!a[0] || !b[0]) return null;
    return scorePair(productSubject(a[0]), productSubject(b[0]), {
      config: this.config,
      productOnly: true,
    });
  }
}

function compareResults(x: PairResult, y: PairResult): number {
  return (
    RANK[x.decision] - RANK[y.decision] ||
    y.scoreBp - x.scoreBp ||
    String(x.productB.id).localeCompare(String(y.productB.id))
  );
}
