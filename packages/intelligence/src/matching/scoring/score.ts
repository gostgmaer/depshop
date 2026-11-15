/**
 * Pair scoring: listing (or product A) vs candidate product B.
 *
 * Evidence, strongest first: identifier (GTIN/EAN/UPC) → MPN → brand + model
 * number → normalized title (exact, then pg_trgm-compatible fuzzy) → optional
 * semantic similarity. Guards that override evidence:
 *   - different brand → no match;
 *   - a differing critical product attribute (generation/line tokens on both
 *     sides, processor, GPU, display, resolution, panel, capacity, energy
 *     rating, model number) → no match (or review, if an identifier says same);
 *   - one-sided line/generation tokens, unverifiable critical attributes,
 *     ambiguous variants → capped below auto-merge (manual review);
 *   - title evidence alone (fuzzy/semantic, or an exact title without any
 *     corroborating attribute) can never auto-merge.
 */
import { discriminatorConflicts } from "@dealmind/catalog";
import { type VariantRelation, matchVariant } from "../matchers/variant-matcher.js";
import { type AttributeComparison, compareSpecs } from "../normalizers/specifications.js";
import { trigramSimilarity } from "../normalizers/title.js";
import type { Subject } from "../subject.js";
import {
  type ConfidenceLevel,
  DEFAULT_MATCHING_CONFIG,
  type MatchingConfig,
  confidenceOf,
} from "./config.js";

export type EvidenceMethod =
  "IDENTIFIER" | "MPN" | "MODEL_NUMBER" | "NORMALIZED_TITLE" | "FUZZY_TITLE" | "SEMANTIC";
export type PairDecision = "AUTO_MERGE" | "MANUAL_REVIEW" | "NO_MATCH";

export interface Conflict {
  attribute: string;
  a: string | number | null;
  b: string | number | null;
  level: "product" | "variant" | "brand";
  severity: "hard" | "soft";
  note?: string;
}

export interface PairResult {
  productA: { id: string | null; label: string; brand: string };
  productB: { id: string | null; label: string; brand: string };
  scoreBp: number;
  /** Score on the 0–100 scale (two decimals). */
  score: number;
  confidence: ConfidenceLevel;
  decision: PairDecision;
  method: EvidenceMethod;
  evidence: {
    identifier?: string;
    mpn?: string;
    modelKey?: string;
    titleSimilarity: number;
    semanticSimilarity?: number;
    exactTitle: boolean;
    corroborated: boolean;
    comparedAttributes: AttributeComparison[];
    notes: string[];
  };
  conflicts: Conflict[];
  variant?: VariantRelation;
}

export interface PairOptions {
  config?: MatchingConfig;
  /** Cosine similarity from the semantic matcher, when computed. */
  semanticSimilarity?: number;
  /** Compare products only (duplicate detection): skip variant placement. */
  productOnly?: boolean;
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Generation/line tokens used for identity. Display measures ("55inch",
 * "139cm") and resolution words ("4k", "ultra" in "ultra hd") are excluded:
 * the dedicated display/resolution comparisons judge those (so "139 cm (55
 * inch)" vs "55 inch" is not a conflict, while 55 vs 65 inch still is).
 */
function identityTokens(s: Subject): string[] {
  const words = s.normalizedName.split(" ");
  const skip = new Set<string>();
  words.forEach((w, i) => {
    if (/^\d+(?:\.\d+)?(?:inch|inches|in|cm)$/.test(w) || /^[48]k$/.test(w)) skip.add(w);
    if (w === "ultra" && words[i + 1] === "hd") skip.add(w);
  });
  return [
    ...new Set(
      s.discriminators
        .filter((t) => !skip.has(t))
        // "nova7" is "nova 7": a long word glued to a number contributes the number;
        // short model prefixes keep their identity ("s24", "a15", "m2", "i5", "x2").
        .map((t) => /^[a-z]{3,}(\d+)$/.exec(t)?.[1] ?? t),
    ),
  ].sort();
}

export function scorePair(a: Subject, b: Subject, opts: PairOptions = {}): PairResult {
  const cfg = opts.config ?? DEFAULT_MATCHING_CONFIG;
  const ev = cfg.evidence;
  const notes: string[] = [];
  const conflicts: Conflict[] = [];
  const titleSimilarity = round(trigramSimilarity(a.normalizedName, b.normalizedName));
  const exactTitle = a.normalizedName === b.normalizedName;
  const base = {
    productA: { id: a.productId, label: a.label, brand: a.brand },
    productB: { id: b.productId, label: b.label, brand: b.brand },
  };
  const finish = (
    scoreBp: number,
    method: EvidenceMethod,
    decision: PairDecision,
    extra: Partial<PairResult["evidence"]>,
    variant?: VariantRelation,
  ): PairResult => {
    const s = Math.max(0, Math.min(10_000, Math.round(scoreBp)));
    return {
      ...base,
      scoreBp: s,
      score: s / 100,
      confidence: confidenceOf(s, cfg),
      decision,
      method,
      evidence: {
        titleSimilarity,
        exactTitle,
        corroborated: false,
        comparedAttributes: [],
        notes,
        ...extra,
      },
      conflicts,
      ...(variant ? { variant } : {}),
    };
  };

  if (a.brandKey !== b.brandKey) {
    conflicts.push({
      attribute: "brand",
      a: a.brand,
      b: b.brand,
      level: "brand",
      severity: "hard",
    });
    return finish(0, "FUZZY_TITLE", "NO_MATCH", {});
  }

  // ── Evidence ──────────────────────────────────────────────────────────
  const listingVariant = a.variants[0];
  const candidateIds = new Map<string, string | null>();
  for (const v of b.variants) for (const id of v.identifiers) candidateIds.set(id, v.id);
  for (const id of b.productIdentifiers) if (!candidateIds.has(id)) candidateIds.set(id, null);
  let identifier: string | undefined;
  let pinnedVariant: string | undefined;
  for (const v of a.variants) {
    for (const id of v.identifiers) {
      if (candidateIds.has(id)) {
        identifier = id;
        pinnedVariant = candidateIds.get(id) ?? undefined;
      }
    }
  }
  let mpn: string | undefined;
  if (!pinnedVariant && listingVariant?.mpnKey) {
    const hit = b.variants.find((v) => v.mpnKey && v.mpnKey === listingVariant.mpnKey);
    if (hit) {
      mpn = listingVariant.mpnKey;
      pinnedVariant = hit.id ?? undefined;
    }
  }
  const modelMatch = Boolean(a.modelKey && b.modelKey && a.modelKey === b.modelKey);
  const modelConflict = Boolean(a.modelKey && b.modelKey && a.modelKey !== b.modelKey);
  const strongId = Boolean(identifier || mpn);

  // ── Product-level guards ─────────────────────────────────────────────
  const profile = a.profile.name !== "default" ? a.profile : b.profile;
  const compared = compareSpecs(a.productSpecs, b.productSpecs, { ...profile, variant: [] });
  for (const c of compared) {
    if (c.relation === "different") {
      conflicts.push({
        attribute: c.attribute,
        a: c.a,
        b: c.b,
        level: "product",
        severity: "hard",
      });
    }
  }
  const unverified = profile.product.filter(
    (k) => (a.productSpecs[k] === undefined) !== (b.productSpecs[k] === undefined),
  );
  const da = identityTokens(a);
  const db = identityTokens(b);
  const diff = discriminatorConflicts(da, db);
  if (diff.length) {
    const onlyA = da.filter((x) => !db.includes(x));
    const onlyB = db.filter((x) => !da.includes(x));
    // With equal model numbers, extra title words are wording; otherwise they name a different line.
    const both = onlyA.length > 0 && onlyB.length > 0;
    conflicts.push({
      attribute: "generation",
      a: onlyA.join(" ") || null,
      b: onlyB.join(" ") || null,
      level: "product",
      severity: both && !modelMatch ? "hard" : "soft",
      note: both ? "different model/generation tokens" : "line/generation tokens on one side only",
    });
  }
  if (modelConflict) {
    conflicts.push({
      attribute: "modelNumber",
      a: a.modelKey,
      b: b.modelKey,
      level: "product",
      severity: "hard",
    });
  }
  const hard = conflicts.some((c) => c.severity === "hard");
  const soft = conflicts.some((c) => c.severity === "soft");
  const corroborated =
    compared.some((c) => c.relation === "equal") || (da.length > 0 && diff.length === 0);

  // ── Base score from the strongest evidence ───────────────────────────
  let method: EvidenceMethod;
  let score: number;
  if (identifier) {
    method = "IDENTIFIER";
    score = ev.identifier;
  } else if (mpn) {
    method = "MPN";
    score = ev.mpn;
  } else if (modelMatch) {
    method = "MODEL_NUMBER";
    score = ev.model;
  } else if (exactTitle) {
    method = "NORMALIZED_TITLE";
    score = corroborated ? ev.titleCorroborated : ev.titleUncorroborated;
    if (!corroborated) notes.push("exact title without a corroborating attribute");
  } else {
    const fuzzy =
      titleSimilarity >= cfg.minTrigramSimilarity
        ? Math.min(ev.fuzzyCap, ev.fuzzyFloor + titleSimilarity * ev.fuzzySpan)
        : 0;
    const sem = opts.semanticSimilarity ?? 0;
    const semantic =
      sem >= cfg.minSemanticSimilarity
        ? Math.min(ev.semanticCap, ev.semanticFloor + sem * ev.semanticSpan)
        : 0;
    method = semantic > fuzzy ? "SEMANTIC" : "FUZZY_TITLE";
    score = Math.max(fuzzy, semantic, Math.round(titleSimilarity * 5_000));
  }
  const titleBased =
    method === "NORMALIZED_TITLE" || method === "FUZZY_TITLE" || method === "SEMANTIC";
  const extra = {
    ...(identifier ? { identifier } : {}),
    ...(mpn ? { mpn } : {}),
    ...(modelMatch && a.modelKey ? { modelKey: a.modelKey } : {}),
    ...(opts.semanticSimilarity !== undefined
      ? { semanticSimilarity: round(opts.semanticSimilarity) }
      : {}),
    corroborated,
    comparedAttributes: compared,
  };

  if (hard) {
    if (strongId) {
      notes.push("identifier says same item but a critical attribute conflicts: data needs review");
      return finish(
        Math.max(cfg.reviewBp, Math.min(score, cfg.highBp - 1)),
        method,
        "MANUAL_REVIEW",
        extra,
      );
    }
    return finish(Math.min(score, cfg.reviewBp - 1), method, "NO_MATCH", extra);
  }
  // With an identifier, MPN or model number the item is pinned; one-sided title
  // words are wording. Without one, they may name another line: review.
  const strongEvidence = strongId || modelMatch;
  if (soft && !strongEvidence) {
    score = Math.min(score, cfg.highBp - 1);
    notes.push("one-sided line/generation tokens");
  }
  if (titleBased && unverified.length) {
    score = Math.min(score, cfg.highBp - 1);
    notes.push(`critical attribute(s) stated on one side only: ${unverified.join(", ")}`);
    for (const k of unverified) {
      conflicts.push({
        attribute: k,
        a: a.productSpecs[k] ?? null,
        b: b.productSpecs[k] ?? null,
        level: "product",
        severity: "soft",
        note: "not verifiable",
      });
    }
  }

  // ── Variant placement ────────────────────────────────────────────────
  let variant: VariantRelation | undefined;
  if (!opts.productOnly && listingVariant) {
    variant = matchVariant(listingVariant, b.variants, profile, pinnedVariant);
    if (variant.relation === "AMBIGUOUS") {
      score = Math.min(score, cfg.highBp - 1);
      notes.push(`variant: ${variant.reason}`);
      for (const c of variant.comparisons.filter((x) => x.relation !== "equal")) {
        conflicts.push({
          attribute: c.attribute,
          a: c.a,
          b: c.b,
          level: "variant",
          severity: "soft",
          note: c.relation === "family" ? "same colour family, different name" : "differs",
        });
      }
    }
  }

  const decision: PairDecision =
    score >= cfg.highBp ? "AUTO_MERGE" : score >= cfg.reviewBp ? "MANUAL_REVIEW" : "NO_MATCH";
  return finish(score, method, decision, extra, variant);
}
