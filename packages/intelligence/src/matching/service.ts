/**
 * Match service for the internal API (and the Python agent): dry-run matching
 * of listings against the shared catalog. It never writes catalog data; it
 * records an audit row per decision and, for uncertain matches from an
 * ACTIVE source, queues a manual review (so a human can resolve it).
 * Identical requests inside one batch are computed once.
 */
import { createHash } from "node:crypto";
import { normalizeListing, sourceListingSchema } from "@dealmind/catalog";
import type { Prisma, PrismaClient } from "@dealmind/db";
import type { MatchingEngine } from "./engine.js";
import { recordAudit } from "./deduplication/importer.js";
import { matchRequestSchema, type MatchRequest } from "./schemas/api.js";
import type { PairResult } from "./scoring/score.js";

/** Validated JSON-safe values → Prisma JSON input. */
const json = (v: unknown) => v as Prisma.InputJsonValue;

export interface MatchView {
  matchId: string;
  productA: { label: string; brand: string; sourceId: string | null; externalId: string };
  productB: { id: string | null; label: string; brand: string } | null;
  score: number;
  scoreBp: number;
  confidence: string;
  decision: "AUTO_MERGE" | "MANUAL_REVIEW" | "NEW_PRODUCT";
  method: string;
  evidence: PairResult["evidence"] | Record<string, never>;
  conflicts: PairResult["conflicts"];
  variant: PairResult["variant"] | null;
  candidates: { productId: string | null; label: string; score: number; decision: string }[];
  reviewId: string | null;
  deduplicated?: boolean;
}

export class MatchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly engine: MatchingEngine,
  ) {}

  async match(input: MatchRequest): Promise<MatchView> {
    const req = matchRequestSchema.parse(input);
    const listing = normalizeListing(sourceListingSchema.parse(req.listing));
    const source = req.sourceId
      ? await this.prisma.shoppingSource.findUnique({
          where: { slug: req.sourceId },
          select: { id: true, status: true },
        })
      : null;
    const result = await this.engine.matchListing(
      this.prisma,
      listing,
      listing.raw.categorySlug ?? null,
    );
    const best = result.best;
    const decision = result.decision;
    const auditId = await recordAudit(
      this.prisma,
      {
        subject: "LISTING",
        origin: "INTERNAL_API",
        sourceId: source?.id ?? null,
        externalId: listing.raw.externalId,
        listing: listing.raw,
        candidateProductId: best?.productB.id ?? null,
        candidateVariantId:
          best?.variant && "variantId" in best.variant ? (best.variant.variantId ?? null) : null,
        scoreBp: best?.scoreBp ?? 0,
        decision,
        method: decision === "NEW_PRODUCT" ? "NEW_PRODUCT" : best!.method,
        evidence: best ? { ...best.evidence, dryRun: true } : { dryRun: true },
        conflicts: best?.conflicts ?? [],
      },
      this.engine.config,
    );
    let reviewId: string | null = null;
    const existing =
      decision === "MANUAL_REVIEW" && source
        ? await this.prisma.productMatchReview.findUnique({
            where: {
              sourceId_externalId: { sourceId: source.id, externalId: listing.raw.externalId },
            },
            select: { status: true },
          })
        : null;
    // Never reopen a review a human already resolved.
    if (
      decision === "MANUAL_REVIEW" &&
      source?.status === "ACTIVE" &&
      (!existing || existing.status === "PENDING")
    ) {
      const evidence = { ...best!.evidence, conflicts: best!.conflicts } as object;
      const review = await this.prisma.productMatchReview.upsert({
        where: { sourceId_externalId: { sourceId: source.id, externalId: listing.raw.externalId } },
        create: {
          sourceId: source.id,
          externalId: listing.raw.externalId,
          listing: json(listing.raw),
          candidateProductId: best!.productB.id,
          confidence: best!.scoreBp,
          method: best!.method,
          evidence,
          auditId,
        },
        update: {
          auditId,
          confidence: best!.scoreBp,
          candidateProductId: best!.productB.id,
          method: best!.method,
          evidence,
        },
      });
      reviewId = review.id;
    }
    return {
      matchId: auditId,
      productA: {
        label: listing.raw.title,
        brand: listing.brand,
        sourceId: req.sourceId ?? null,
        externalId: listing.raw.externalId,
      },
      productB: best ? best.productB : null,
      score: (best?.scoreBp ?? 0) / 100,
      scoreBp: best?.scoreBp ?? 0,
      confidence: best?.confidence ?? "LOW",
      decision,
      method: decision === "NEW_PRODUCT" ? "NEW_PRODUCT" : best!.method,
      evidence: best?.evidence ?? {},
      conflicts: best?.conflicts ?? [],
      variant: best?.variant ?? null,
      candidates: result.candidates.map((c) => ({
        productId: c.productB.id,
        label: c.productB.label,
        score: c.score,
        decision: c.decision,
      })),
      reviewId,
    };
  }

  /** Batch matching with request deduplication (identical requests share one result). */
  async matchBatch(items: MatchRequest[]): Promise<MatchView[]> {
    const byKey = new Map<string, Promise<MatchView>>();
    const keys = items.map((item) => {
      const parsed = matchRequestSchema.parse(item);
      return createHash("sha256")
        .update(JSON.stringify([parsed.sourceId ?? null, parsed.listing]))
        .digest("hex");
    });
    const out: MatchView[] = [];
    // Sequential per unique request keeps load bounded and audit order stable.
    for (const [i, item] of items.entries()) {
      const key = keys[i]!;
      const existing = byKey.get(key);
      if (existing) {
        out.push({ ...(await existing), deduplicated: true });
        continue;
      }
      const p = this.match(item);
      byKey.set(key, p);
      out.push(await p);
    }
    return out;
  }
}
