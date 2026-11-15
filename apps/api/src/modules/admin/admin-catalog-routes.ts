/**
 * Admin catalog curation: the manual-review queue of uncertain matches.
 * ADMIN role required (server-side). Resolving replays the stored listing
 * through the normal importer and invalidates the affected product caches.
 */
import { CatalogImporter, ReviewInputError, SourceNotActiveError } from "@dealmind/intelligence";
import type { PrismaClient } from "@dealmind/db";
import { AppError, ErrorCode, pageQuery, paginationOf } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { iso, ok, page, paginated } from "../../utils/http.js";
import { getAuth } from "../../plugins/auth.js";
import { recordAudit } from "../users/audit.js";
import type { CatalogService } from "../catalog/catalog-service.js";

const security = [{ sessionCookie: [] }];

const reviewView = z.object({
  id: z.string().uuid(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  source: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string() }),
  externalId: z.string(),
  listing: z.record(z.unknown()),
  candidateProduct: z
    .object({ id: z.string().uuid(), name: z.string(), brand: z.string() })
    .nullable(),
  method: z.string(),
  confidence: z.number().int(),
  evidence: z.record(z.unknown()),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
});

const resolveInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), productId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("create") }).strict(),
  z.object({ action: z.literal("reject") }).strict(),
]);

const resolveResult = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  productId: z.string().uuid().nullable(),
  offerId: z.string().uuid().nullable(),
});

export const adminCatalogRoutes: FastifyPluginAsyncZod<{
  prisma: PrismaClient;
  catalog: CatalogService;
}> = async (app, { prisma, catalog }) => {
  app.addHook("preHandler", app.requireAdmin);
  const importer = new CatalogImporter(prisma, {
    onProductsChanged: (ids) => catalog.invalidateProducts(ids),
  });

  app.get(
    "/match-reviews",
    {
      schema: {
        tags: ["admin"],
        summary: "Uncertain catalog matches awaiting manual review",
        security,
        querystring: pageQuery
          .extend({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING") })
          .strict(),
        response: { 200: page(reviewView) },
      },
    },
    async (req) => {
      const where = { status: req.query.status };
      const [rows, total] = await Promise.all([
        prisma.productMatchReview.findMany({
          where,
          orderBy: { createdAt: "asc" },
          skip: (req.query.page - 1) * req.query.pageSize,
          take: req.query.pageSize,
          include: {
            source: { select: { id: true, slug: true, name: true } },
            candidateProduct: { select: { id: true, name: true, brand: true } },
          },
        }),
        prisma.productMatchReview.count({ where }),
      ]);
      return paginated(
        rows.map((r) => ({
          id: r.id,
          status: r.status,
          source: r.source,
          externalId: r.externalId,
          listing: r.listing as Record<string, unknown>,
          candidateProduct: r.candidateProduct,
          method: r.method,
          confidence: r.confidence,
          evidence: (r.evidence ?? {}) as Record<string, unknown>,
          createdAt: r.createdAt.toISOString(),
          reviewedAt: iso(r.reviewedAt),
        })),
        paginationOf(req.query, total),
      );
    },
  );

  app.post(
    "/match-reviews/:id/resolve",
    {
      schema: {
        tags: ["admin"],
        summary: "Resolve a review: attach to a product, create a new product, or reject",
        security,
        params: z.object({ id: z.string().uuid() }),
        body: resolveInput,
        response: { 200: ok(resolveResult) },
      },
    },
    async (req) => {
      const review = await prisma.productMatchReview.findUnique({ where: { id: req.params.id } });
      if (!review) throw AppError.notFound("Match review");
      if (review.status !== "PENDING")
        throw AppError.conflict(`Review is already ${review.status}`);
      if (
        req.body.action === "match" &&
        !(await prisma.product.count({ where: { id: req.body.productId } }))
      ) {
        throw AppError.notFound("Product");
      }
      let outcome;
      try {
        outcome = await importer.resolveReview(review.id, req.body, {
          userId: getAuth(req).userId,
        });
      } catch (err) {
        if (err instanceof ReviewInputError)
          throw new AppError(ErrorCode.VALIDATION_ERROR, err.message);
        if (err instanceof SourceNotActiveError) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, err.message);
        }
        throw err;
      }
      await recordAudit(prisma, {
        actorId: getAuth(req).userId,
        action: "admin.catalog_match_review_resolved",
        entity: "ProductMatchReview",
        entityId: review.id,
        metadata: {
          action: req.body.action,
          ...(outcome?.status === "imported" ? { productId: outcome.productId } : {}),
        },
      });
      return outcome?.status === "imported"
        ? { status: "APPROVED" as const, productId: outcome.productId, offerId: outcome.offerId }
        : { status: "REJECTED" as const, productId: null, offerId: null };
    },
  );
};
