/**
 * GET /api/v1/affiliate/click/:offerId — the only way DealMind sends users to
 * a marketplace. The destination is the offer's stored URL, validated against
 * the source's domain and the provider's host allowlist (never a client value);
 * the click is recorded, then the user is redirected (302).
 *
 * Admin (ADMIN role, audited): affiliate analytics and program status,
 * enabling affiliate links per source, importing partner-reported conversions
 * (Flipkart Report API, or a partner report entered by an admin) and payouts.
 */
import {
  type AffiliateRegistry,
  SURFACES,
  affiliateSummary,
  fetchFlipkartOrders,
  importConversions,
  recordPayout,
  reportedConversion,
  resolveClick,
} from "@dealmind/affiliate";
import type { PrismaClient } from "@dealmind/db";
import { AppError, ErrorCode } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { recordAudit } from "../users/audit.js";

export interface AffiliateDeps {
  prisma: PrismaClient;
  registry: AffiliateRegistry;
  redis: Redis;
  redisPrefix: string;
  ipSalt: string;
  fetch?: typeof fetch;
}

export const affiliateClickRoutes: FastifyPluginAsyncZod<AffiliateDeps> = async (app, deps) => {
  app.get(
    "/click/:offerId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["affiliate"],
        summary: "Go to the marketplace for an offer (records the click; may add an affiliate tag)",
        params: z.object({ offerId: z.string().uuid() }),
        querystring: z.object({ from: z.enum(SURFACES).optional() }).strict(),
      },
    },
    async (req, reply) => {
      const auth = await app.optionalAuth(req);
      const r = await resolveClick(
        {
          prisma: deps.prisma,
          registry: deps.registry,
          ipSalt: deps.ipSalt,
          firstSeen: async (key, ttl) =>
            (await deps.redis.set(`${deps.redisPrefix}:${key}`, "1", "EX", ttl, "NX")) === "OK",
        },
        {
          offerId: req.params.offerId,
          userId: auth?.userId ?? null,
          surface: req.query.from ?? null,
          ip: req.ip ?? null,
          userAgent: req.headers["user-agent"],
          referrer: req.headers.referer,
        },
      );
      reply.header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow");
      if (r.status === "not-found") throw AppError.notFound("Offer");
      if (r.status === "sample")
        throw new AppError(ErrorCode.NOT_FOUND, "This is a sample store with no real listing.");
      if (r.status === "blocked") {
        req.log.warn(
          { offerId: req.params.offerId, reason: r.reason },
          "affiliate redirect blocked",
        );
        throw new AppError(ErrorCode.CONFLICT, "This marketplace link can't be opened safely.");
      }
      return reply.header("referrer-policy", "origin").redirect(r.url, 302);
    },
  );
};

const security = [{ sessionCookie: [] }];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const adminAffiliateRoutes: FastifyPluginAsyncZod<AffiliateDeps> = async (app, deps) => {
  const { prisma } = deps;
  // onRequest: non-admins are refused before body validation (no schema hints).
  app.addHook("onRequest", app.requireAdmin);

  app.get(
    "/",
    {
      schema: {
        tags: ["admin"],
        summary:
          "Affiliate analytics (recorded clicks; partner-reported money only) and program status",
        security,
        querystring: z
          .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
          .strict(),
      },
    },
    async (req) => {
      const to = new Date();
      const from = new Date(to.getTime() - req.query.days * 86_400_000);
      const [summary, sources] = await Promise.all([
        affiliateSummary(prisma, { from, to }),
        prisma.shoppingSource.findMany({
          where: { isSample: false },
          orderBy: { name: "asc" },
          select: { id: true, slug: true, name: true, domain: true, affiliateEnabled: true },
        }),
      ]);
      return {
        summary,
        programs: sources.map((s) => ({
          sourceId: s.id,
          slug: s.slug,
          ...deps.registry.status(s),
        })),
      };
    },
  );

  app.patch(
    "/sources/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Enable or disable affiliate links for a source",
        security,
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ affiliateEnabled: z.boolean() }).strict(),
      },
    },
    async (req) => {
      const before = await prisma.shoppingSource.findUnique({ where: { id: req.params.id } });
      if (!before || before.isSample) throw AppError.notFound("Source");
      const s = await prisma.shoppingSource.update({
        where: { id: before.id },
        data: { affiliateEnabled: req.body.affiliateEnabled },
        select: { id: true, slug: true, name: true, domain: true, affiliateEnabled: true },
      });
      await recordAudit(prisma, {
        actorId: getAuth(req).userId,
        action: "admin.affiliate_source_updated",
        entity: "ShoppingSource",
        entityId: s.id,
        metadata: {
          before: { affiliateEnabled: before.affiliateEnabled },
          after: { affiliateEnabled: s.affiliateEnabled },
        },
      });
      return { sourceId: s.id, ...deps.registry.status(s) };
    },
  );

  app.post(
    "/import/flipkart",
    {
      schema: {
        tags: ["admin"],
        summary: "Import orders from the Flipkart Affiliate Orders Report API (provider-reported)",
        security,
        body: z.object({ startDate: isoDate, endDate: isoDate }).strict(),
      },
    },
    async (req) => {
      const creds = deps.registry.flipkartReporting();
      if (!creds)
        throw new AppError(
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          "Flipkart reporting isn't configured (FLIPKART_AFFILIATE_ID and FLIPKART_AFFILIATE_TOKEN).",
        );
      const source = await prisma.shoppingSource.findUnique({ where: { slug: "flipkart" } });
      if (!source) throw AppError.notFound("Source");
      let report;
      try {
        report = await fetchFlipkartOrders({
          affiliateId: creds.affiliateId,
          token: creds.token,
          startDate: req.body.startDate,
          endDate: req.body.endDate,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
      } catch (err) {
        throw new AppError(
          ErrorCode.SOURCE_UNAVAILABLE,
          `Flipkart report failed: ${(err as Error).message}`,
        );
      }
      const summary = await importConversions(prisma, {
        sourceId: source.id,
        provider: "flipkart-affiliate",
        rows: report.rows,
        now: new Date(),
      });
      await recordAudit(prisma, {
        actorId: getAuth(req).userId,
        action: "admin.affiliate_conversions_imported",
        entity: "ShoppingSource",
        entityId: source.id,
        metadata: {
          provider: "flipkart-affiliate",
          ...req.body,
          ...summary,
          rejected: report.rejected.length,
        },
      });
      return { ...summary, rejected: report.rejected };
    },
  );

  app.post(
    "/import/manual",
    {
      schema: {
        tags: ["admin"],
        summary: "Import conversions from a partner report (e.g. Amazon Associates Central)",
        security,
        body: z
          .object({
            sourceSlug: z.string().regex(/^[a-z][a-z0-9_]*$/),
            rows: z
              .array(reportedConversion.extend({ orderedAt: z.string().datetime().nullable() }))
              .min(1)
              .max(5_000),
          })
          .strict(),
      },
    },
    async (req) => {
      const source = await prisma.shoppingSource.findUnique({
        where: { slug: req.body.sourceSlug },
      });
      if (!source || source.isSample) throw AppError.notFound("Source");
      const provider = deps.registry.program(source).id;
      if (provider === "direct")
        throw new AppError(
          ErrorCode.CONFLICT,
          "This source has no affiliate program to report conversions for.",
        );
      const summary = await importConversions(prisma, {
        sourceId: source.id,
        provider,
        rows: req.body.rows.map((r) => ({
          ...r,
          orderedAt: r.orderedAt ? new Date(r.orderedAt) : null,
        })),
        now: new Date(),
      });
      await recordAudit(prisma, {
        actorId: getAuth(req).userId,
        action: "admin.affiliate_conversions_imported",
        entity: "ShoppingSource",
        entityId: source.id,
        metadata: { provider, manual: true, ...summary },
      });
      return summary;
    },
  );

  app.post(
    "/payouts",
    {
      schema: {
        tags: ["admin"],
        summary: "Record a payout as reported by the partner",
        security,
        body: z
          .object({
            sourceSlug: z.string().regex(/^[a-z][a-z0-9_]*$/),
            amountPaise: z.number().int().nonnegative(),
            status: z.enum(["PENDING", "PAID", "FAILED"]),
            payoutReference: z.string().trim().min(1).max(200),
            paidAt: z.string().datetime().nullable().default(null),
            periodStart: z.string().datetime().nullable().default(null),
            periodEnd: z.string().datetime().nullable().default(null),
          })
          .strict()
          .refine(
            (b) => (b.status === "PAID") === (b.paidAt !== null),
            "paidAt is required exactly when PAID",
          ),
      },
    },
    async (req) => {
      const source = await prisma.shoppingSource.findUnique({
        where: { slug: req.body.sourceSlug },
      });
      if (!source || source.isSample) throw AppError.notFound("Source");
      const provider = deps.registry.program(source).id;
      if (provider === "direct")
        throw new AppError(ErrorCode.CONFLICT, "This source has no affiliate program.");
      const p = await recordPayout(prisma, {
        provider,
        sourceId: source.id,
        amountPaise: req.body.amountPaise,
        status: req.body.status,
        payoutReference: req.body.payoutReference,
        paidAt: req.body.paidAt ? new Date(req.body.paidAt) : null,
        periodStart: req.body.periodStart ? new Date(req.body.periodStart) : null,
        periodEnd: req.body.periodEnd ? new Date(req.body.periodEnd) : null,
      });
      await recordAudit(prisma, {
        actorId: getAuth(req).userId,
        action: "admin.affiliate_payout_recorded",
        entity: "AffiliatePayout",
        entityId: p.id,
        metadata: {
          provider,
          amountPaise: req.body.amountPaise,
          status: req.body.status,
          payoutReference: req.body.payoutReference,
        },
      });
      return { id: p.id, status: p.status, amountPaise: Number(p.amountPaise) };
    },
  );
};
