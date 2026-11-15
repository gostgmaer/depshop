/**
 * Match records and the manual review workflow.
 *
 * Only a HUMAN reviewer may resolve a review: every resolution requires the
 * id of an ACTIVE user with the ADMIN role (verified here), and the internal
 * API additionally requires a reviewer context signed by the admin backend —
 * a secret the Python agent never has. An LLM can therefore never approve a
 * merge. Each resolution is appended to the audit trail (REVIEW_RESOLVED).
 */
import type { PrismaClient } from "@dealmind/db";
import {
  type CatalogImporter,
  ReviewInputError,
  type ReviewResolution,
  recordAudit,
} from "../deduplication/importer.js";
import { mergeProducts } from "../deduplication/duplicates.js";

export class ReviewNotAllowedError extends Error {
  override readonly name = "ReviewNotAllowedError";
}

export type PairResolution = { action: "merge"; keepProductId: string } | { action: "reject" };

export class MatchReviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly importer: CatalogImporter,
    private readonly onProductsChanged: (ids: string[]) => Promise<void> | void = () => undefined,
  ) {}

  async getMatch(id: string) {
    const audit = await this.prisma.productMatchAudit.findUnique({ where: { id } });
    if (!audit) return null;
    const [resolutions, review] = await Promise.all([
      this.prisma.productMatchAudit.findMany({
        where: { reviewOfId: id },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.productMatchReview.findFirst({ where: { auditId: id } }),
    ]);
    return {
      ...audit,
      score: audit.scoreBp / 100,
      review: review
        ? {
            id: review.id,
            status: review.status,
            reviewedBy: review.reviewedBy,
            reviewedAt: review.reviewedAt?.toISOString() ?? null,
          }
        : null,
      resolutions,
    };
  }

  private async assertHumanAdmin(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, status: true },
    });
    if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE") {
      throw new ReviewNotAllowedError("Only an active admin user can resolve match reviews");
    }
  }

  /** Resolves a MANUAL_REVIEW decision (listing or product pair) exactly once. */
  async review(
    auditId: string,
    resolution: ReviewResolution | PairResolution,
    reviewer: { userId: string; note?: string },
  ) {
    await this.assertHumanAdmin(reviewer.userId);
    const audit = await this.prisma.productMatchAudit.findUnique({ where: { id: auditId } });
    if (!audit) throw new ReviewInputError("Match not found");
    if (audit.decision !== "MANUAL_REVIEW")
      throw new ReviewInputError(
        `Only MANUAL_REVIEW decisions can be reviewed (this one is ${audit.decision})`,
      );
    if (await this.prisma.productMatchAudit.count({ where: { reviewOfId: auditId } })) {
      throw new ReviewInputError("This match has already been reviewed");
    }

    if (audit.subject === "LISTING") {
      const review = await this.prisma.productMatchReview.findFirst({
        where: { auditId, status: "PENDING" },
      });
      if (!review) throw new ReviewInputError("No pending review for this match");
      if (resolution.action === "merge")
        throw new ReviewInputError("Use match/create/reject for listings");
      return { outcome: await this.importer.resolveReview(review.id, resolution, reviewer) };
    }

    // PRODUCT_PAIR
    if (resolution.action !== "merge" && resolution.action !== "reject") {
      throw new ReviewInputError("Use merge/reject for product pairs");
    }
    const a = audit.productAId!;
    const b = audit.candidateProductId!;
    if (resolution.action === "merge" && ![a, b].includes(resolution.keepProductId)) {
      throw new ReviewInputError("keepProductId must be one of the two products");
    }
    const result = await this.prisma.$transaction(async (tx) => {
      let merged: { movedVariants: number; foldedVariants: number } | null = null;
      if (resolution.action === "merge") {
        const mergeId = resolution.keepProductId === a ? b : a;
        merged = await mergeProducts(tx, resolution.keepProductId, mergeId);
      }
      await recordAudit(tx, {
        subject: "PRODUCT_PAIR",
        origin: "REVIEW",
        productAId: a,
        candidateProductId: b,
        resultProductId: resolution.action === "merge" ? resolution.keepProductId : null,
        scoreBp: resolution.action === "merge" ? 10_000 : 0,
        decision: "REVIEW_RESOLVED",
        method: "MANUAL",
        evidence: { resolution: resolution.action, ...(merged ?? {}) },
        reviewOfId: auditId,
        reviewer: reviewer.userId,
        note: reviewer.note ?? null,
      });
      return merged;
    });
    if (resolution.action === "merge") await this.onProductsChanged([a, b]);
    return { merged: result };
  }
}
