/**
 * Internal service API for the Python agent (apps/agent). Mounted at
 * /internal/v1, service-token protected, never routed publicly.
 *
 *  Marketplace (reuses @dealmind/connectors; credentials never leave this process)
 *    POST /sources/eligible           eligible + skipped sources for a request
 *    GET  /sources/:id                status of one source (no secrets)
 *    POST /marketplace/search         parallel connector execution, per-source results
 *  Intelligence (deterministic; reuses @dealmind/catalog + @dealmind/intelligence)
 *    POST /intelligence/normalize     catalog normalization of items
 *    POST /intelligence/deduplicate   catalog matching → shared offers, product/variant groups
 *  Pricing & ranking (@dealmind/intelligence; offer ids + user-stated eligibility in, never prices)
 *    POST /intelligence/pricing/calculate   full pricing of one offer
 *    POST /intelligence/pricing/batch       … of up to 400 offers
 *    GET  /intelligence/pricing/history/:offerId   history analytics + observations
 *    POST /intelligence/ranking/rank        hard filters → mode strategy → explained ranking,
 *                                           plus a signed ranking token (see ranking-token.ts)
 *    POST /intelligence/ranking/compare     side-by-side comparison of 2–20 offers
 *  Matching (@dealmind/intelligence matching engine; dry run + audit trail)
 *    POST /intelligence/match               match one listing against the shared catalog
 *    POST /intelligence/match/batch         up to 100 listings (identical requests deduplicated)
 *    GET  /intelligence/matches/:id         a match audit record, its review and resolutions
 *    POST /intelligence/matches/:id/review  HUMAN-only: needs a reviewer context signed by
 *                                           the admin backend (REVIEW_CONTEXT_SECRET, which
 *                                           the agent never has) + an ACTIVE ADMIN user
 *  Private records (signed user context + ownership re-checked)
 *    GET  /searches/:id               the search, only for its owner
 *    POST /searches/:id/events        progress event → SSE subscribers
 *    PUT  /searches/:id/agent-result  idempotent persistence of results/runs/agent run
 */
import { canonicalAttributes } from "@dealmind/catalog";
import type { CatalogService } from "../catalog/catalog-service.js";
import {
  type ConnectorRegistry,
  type ParallelSearchExecutor,
  type SourceConfigProvider,
  normalizedProductSchema,
  shoppingSearchRequestSchema,
} from "@dealmind/connectors";
import type { Prisma, PrismaClient } from "@dealmind/db";
import {
  type MatchReviewService,
  type MatchService,
  ReviewInputError,
  ReviewNotAllowedError,
  OfferNotFoundError,
  SORT_MODES,
  eligibilityContextSchema,
  hardFiltersSchema,
  pricingResultSchema,
  rankedDealSchema,
  weightsSchema,
  matchBatchSchema,
  matchRequestSchema,
  reviewRequestSchema,
} from "@dealmind/intelligence";
import { AppError, ErrorCode } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { InternalIntelligence } from "./internal-intelligence.js";
import {
  RANKING_TOKEN_TTL_SECONDS,
  matchesRanking,
  signRankingToken,
  verifyRankingToken,
} from "./ranking-token.js";
import {
  type UserContext,
  serviceAuth,
  verifyReviewerContext,
  verifyUserContext,
} from "./service-auth.js";

export const USER_CONTEXT_HEADER = "x-dealmind-user-context";
export const REVIEWER_CONTEXT_HEADER = "x-dealmind-reviewer-context";
/** A reviewer context is a short-lived, per-decision grant. */
const MAX_REVIEWER_CONTEXT_SECONDS = 15 * 60;

export interface InternalDeps {
  prisma: PrismaClient;
  redis: Redis;
  redisPrefix: string;
  token: string;
  userContextSecret: string;
  registry: ConnectorRegistry;
  sources: SourceConfigProvider;
  executor: ParallelSearchExecutor;
  intelligence: InternalIntelligence;
  catalog: CatalogService;
  allowMocks: boolean;
  matches: MatchService;
  reviews: MatchReviewService;
  /** Unset → match reviews cannot be resolved through the internal API. */
  reviewContextSecret: string | null;
  /** Signs ranking tokens; derived from SESSION_SECRET (never shared with the agent). */
  rankingKey: Buffer;
}

const slug = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);
const uuid = z.string().uuid();
const items = z.array(normalizedProductSchema).max(400);
const offerIds = z.array(uuid).min(1).max(400);
const eligibility = eligibilityContextSchema.optional();
const specValue = z.union([z.string().max(100), z.number()]);

const offerFactsSchema = z.object({
  offerId: uuid,
  productId: uuid,
  variantId: uuid,
  sourceSlug: z.string(),
  sourceName: z.string(),
  isSample: z.boolean(),
  title: z.string(),
  productName: z.string(),
  brand: z.string(),
  productUrl: z.string(),
  sellerName: z.string().nullable(),
  stockStatus: z.enum(["IN_STOCK", "LIMITED", "OUT_OF_STOCK", "PREORDER", "UNKNOWN"]),
  launchDate: z.string().nullable(),
  variantAttributes: z.record(z.unknown()),
  specifications: z.record(z.unknown()),
  offerConditions: z.record(z.unknown()),
  observedAt: z.string(),
  pricing: pricingResultSchema,
});

const rankingRequestSchema = z
  .object({
    offerIds,
    mode: z.enum(SORT_MODES),
    query: z.string().max(500).optional(),
    filters: hardFiltersSchema.optional(),
    preferredSpecs: z.record(specValue).optional(),
    priceBasis: z.enum(["delivered", "best_verified"]).optional(),
    weights: weightsSchema.optional(),
    maxPriceAgeHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
    recentlyLaunchedDays: z.number().int().min(7).max(3_650).optional(),
    eligibility,
  })
  .strict();

const rankingResponseSchema = z.object({
  requestedMode: z.string(),
  appliedMode: z.string(),
  priceBasis: z.enum(["delivered", "best_verified"]),
  weights: z.object({
    price: z.number(),
    specMatch: z.number(),
    discount: z.number(),
    history: z.number(),
    relevance: z.number(),
    quality: z.number(),
  }),
  ranked: z.array(rankedDealSchema.extend({ offer: offerFactsSchema })),
  excluded: z.array(z.object({ offerId: uuid, reason: z.string(), detail: z.string().optional() })),
  warnings: z.array(z.string()),
  unknownOfferIds: z.array(uuid),
  computedAt: z.string(),
  rankingToken: z.string(),
});

/** Validated JSON records (zod: record of unknown) → Prisma JSON input. */
const toJson = (v: Record<string, unknown>): Prisma.InputJsonObject => v as Prisma.InputJsonObject;

export const searchEventsChannel = (prefix: string, searchId: string) =>
  `${prefix}:search-events:${searchId}`;
export const searchEventsLog = (prefix: string, searchId: string) =>
  `${prefix}:search-events-log:${searchId}`;

const agentResultSchema = z
  .object({
    status: z.enum(["COMPLETED", "PARTIAL", "FAILED", "NEEDS_CLARIFICATION", "CANCELLED"]),
    interpretation: z.record(z.unknown()).nullable(),
    clarificationQuestion: z.string().max(500).nullable(),
    response: z.string().max(10_000).nullable(),
    warnings: z.array(z.string().max(500)).max(50).default([]),
    /** Token from /intelligence/ranking/rank; required whenever rankedDeals is non-empty. */
    rankingToken: z.string().max(50_000).nullable().default(null),
    rankedDeals: z
      .array(
        z
          .object({
            offerId: uuid,
            rank: z.number().int().min(1),
            score: z.number().int().min(0).max(10_000),
            explanation: z.string().max(1_000).nullable(),
          })
          .strict(),
      )
      .max(100),
    sourceRuns: z
      .array(
        z
          .object({
            sourceId: slug,
            status: z.enum(["SUCCEEDED", "FAILED", "TIMED_OUT", "SKIPPED"]),
            resultCount: z.number().int().min(0),
            durationMs: z.number().int().min(0),
            errorCode: z.string().max(60).nullable(),
            errorMessage: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .max(100),
    agentRun: z
      .object({
        provider: z.string().max(50),
        model: z.string().max(100),
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
        durationMs: z.number().int().min(0),
        metadata: z.record(z.unknown()),
        error: z.string().max(2_000).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ranks = v.rankedDeals.map((d) => d.rank).sort((a, b) => a - b);
    if (ranks.some((r, i) => r !== i + 1))
      ctx.addIssue({ code: "custom", message: "ranks must be 1..n", path: ["rankedDeals"] });
    if (new Set(v.rankedDeals.map((d) => d.offerId)).size !== v.rankedDeals.length) {
      ctx.addIssue({ code: "custom", message: "duplicate offerId", path: ["rankedDeals"] });
    }
  });
export type AgentResult = z.infer<typeof agentResultSchema>;

const AGENT_STATUS = {
  COMPLETED: "SUCCEEDED",
  PARTIAL: "SUCCEEDED",
  NEEDS_CLARIFICATION: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export const internalRoutes: FastifyPluginAsyncZod<InternalDeps> = async (app, deps) => {
  const { prisma } = deps;
  app.addHook("onRequest", serviceAuth(deps.token));

  /** Verifies the signed user context and that it matches this search and its owner. */
  async function ownedSearch(
    header: unknown,
    searchId: string,
  ): Promise<{ ctx: UserContext; userId: string }> {
    const ctx =
      typeof header === "string" ? verifyUserContext(header, deps.userContextSecret) : null;
    if (!ctx) throw new AppError(ErrorCode.FORBIDDEN, "Valid signed user context required");
    if (ctx.searchId !== searchId)
      throw new AppError(ErrorCode.FORBIDDEN, "User context does not match this search");
    const search = await prisma.search.findFirst({
      where: { id: searchId, userId: ctx.userId },
      select: { id: true },
    });
    if (!search) throw AppError.notFound("Search");
    return { ctx, userId: ctx.userId };
  }

  const noRateLimit = { rateLimit: false } as const;

  app.post(
    "/sources/eligible",
    {
      config: noRateLimit,
      schema: {
        body: z
          .object({ request: shoppingSearchRequestSchema, only: z.array(slug).max(50).optional() })
          .strict(),
      },
    },
    async (req) => {
      const request = shoppingSearchRequestSchema.parse(req.body.request);
      const { eligible, skipped } = deps.registry.eligible(await deps.sources.list(), request, {
        ...(req.body.only ? { only: req.body.only } : {}),
        allowMocks: deps.allowMocks,
      });
      return {
        eligible: eligible.map((e) => ({
          sourceId: e.source.slug,
          name: e.source.name,
          isMock: e.connector.isMock,
          capabilities: e.connector.getCapabilities(),
          timeoutMs: e.source.timeoutMs,
        })),
        skipped: skipped
          .filter((s) => s.reason !== "NOT_REQUESTED")
          .map((s) => ({
            sourceId: s.source.slug,
            name: s.source.name,
            reason: s.reason,
            detail: s.detail ?? null,
          })),
      };
    },
  );

  app.get(
    "/sources/:id",
    { config: noRateLimit, schema: { params: z.object({ id: z.union([uuid, slug]) }) } },
    async (req) => deps.catalog.getSource(req.params.id),
  );

  app.post(
    "/marketplace/search",
    {
      config: noRateLimit,
      schema: {
        body: z
          .object({ request: shoppingSearchRequestSchema, only: z.array(slug).max(50).optional() })
          .strict(),
      },
    },
    async (req) => {
      const run = await deps.executor.run(
        req.body.request,
        req.body.only ? { only: req.body.only } : {},
      );
      req.log.info(
        {
          correlationId: req.headers["x-correlation-id"],
          status: run.status,
          durationMs: run.durationMs,
        },
        "internal marketplace search",
      );
      return {
        status: run.status,
        fingerprint: run.fingerprint,
        durationMs: run.durationMs,
        sources: run.sources.map(({ items: _items, sourceDbId: _db, ...s }) => ({
          ...s,
          errorCode: s.errorCode ?? null,
          errorMessage: s.errorMessage ?? null,
        })),
        items: run.items,
      };
    },
  );

  /**
   * The admin-managed LLM configuration for the agent (Phase 6.3). No API keys:
   * the agent uses its own environment keys for the named provider. When the
   * monthly token budget is used up, `limitReached` tells the agent to stop
   * calling the LLM (rule-based extraction only) until the next month.
   */
  app.get("/ai-config", { config: noRateLimit }, async () => {
    const row = await prisma.aiModelConfig.findUnique({ where: { purpose: "INTENT_EXTRACTION" } });
    if (!row) return { config: null, limitReached: false };
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const used = row.monthlyTokenLimit
      ? await prisma.agentRun.aggregate({
          where: { startedAt: { gte: since } },
          _sum: { inputTokens: true, outputTokens: true },
        })
      : null;
    const tokens = (used?._sum.inputTokens ?? 0) + (used?._sum.outputTokens ?? 0);
    return {
      config: {
        provider: row.provider,
        model: row.model,
        temperature: row.temperature,
        maxTokens: row.maxTokens,
        enabled: row.enabled,
        fallbackProvider: row.fallbackProvider,
        fallbackModel: row.fallbackModel,
        updatedAt: row.updatedAt.toISOString(),
      },
      limitReached: row.monthlyTokenLimit !== null && tokens >= row.monthlyTokenLimit,
    };
  });

  app.get("/categories", { config: noRateLimit }, async () => ({
    categories: (await deps.catalog.listCategories()).map((c) => ({ slug: c.slug, name: c.name })),
  }));

  /**
   * User-stated requirements ("ram: 8GB", "capacity: 1.5 ton") → the same
   * canonical attribute keys the catalog normalizer stores on variants, so
   * filters compare like with like.
   */
  app.post(
    "/intelligence/canonical-specs",
    {
      config: noRateLimit,
      schema: {
        body: z
          .object({
            specs: z
              .array(
                z
                  .object({ name: z.string().min(1).max(40), value: z.string().min(1).max(60) })
                  .strict(),
              )
              .max(20),
          })
          .strict(),
      },
    },
    async (req) => {
      const specs = req.body.specs;
      // Capacities are recognised from text ("1.5 ton capacity" → capacity_ton).
      // A canonical key sent back by the category filters (capacity_l: "7") is kept as is.
      const isCapacity = (n: string) =>
        /capacity|volume|load/i.test(n) && !/^capacity_(l|kg|ton|gb)$/.test(n);
      const attributes = canonicalAttributes(
        specs.map((s) => `${s.value} ${s.name}`).join(" , "),
        Object.fromEntries(specs.filter((s) => !isCapacity(s.name)).map((s) => [s.name, s.value])),
      );
      return { attributes };
    },
  );

  app.post(
    "/intelligence/normalize",
    {
      config: noRateLimit,
      schema: { body: z.object({ items, categorySlug: z.string().max(100).optional() }).strict() },
    },
    async (req) => ({
      results: deps.intelligence.normalize(req.body.items, req.body.categorySlug),
    }),
  );

  app.post(
    "/intelligence/deduplicate",
    {
      config: noRateLimit,
      schema: { body: z.object({ items, categorySlug: z.string().max(100).optional() }).strict() },
    },
    async (req) => deps.intelligence.deduplicate(req.body.items, req.body.categorySlug),
  );

  app.post(
    "/intelligence/pricing/calculate",
    {
      config: noRateLimit,
      schema: {
        body: z.object({ offerId: uuid, eligibility }).strict(),
        response: { 200: z.object({ offer: offerFactsSchema }) },
      },
    },
    async (req) => {
      const [offer] = await deps.intelligence.offerFacts([req.body.offerId], req.body.eligibility);
      if (!offer) throw AppError.notFound("Offer");
      return { offer };
    },
  );

  app.post(
    "/intelligence/pricing/batch",
    {
      config: noRateLimit,
      schema: {
        body: z.object({ offerIds, eligibility }).strict(),
        response: {
          200: z.object({ offers: z.array(offerFactsSchema), unknownOfferIds: z.array(uuid) }),
        },
      },
    },
    async (req) => {
      const offers = await deps.intelligence.offerFacts(req.body.offerIds, req.body.eligibility);
      const known = new Set(offers.map((o) => o.offerId));
      return {
        offers,
        unknownOfferIds: [...new Set(req.body.offerIds)].filter((id) => !known.has(id)),
      };
    },
  );

  app.get(
    "/intelligence/pricing/history/:offerId",
    {
      config: noRateLimit,
      schema: {
        params: z.object({ offerId: uuid }),
        querystring: z.object({ days: z.coerce.number().int().min(7).max(180).default(180) }),
      },
    },
    async (req) => {
      try {
        return await deps.intelligence.pricing.history(req.params.offerId, req.query.days);
      } catch (err) {
        if (err instanceof OfferNotFoundError) throw AppError.notFound("Offer");
        throw err;
      }
    },
  );

  app.post(
    "/intelligence/ranking/rank",
    {
      config: noRateLimit,
      schema: { body: rankingRequestSchema, response: { 200: rankingResponseSchema } },
    },
    async (req) => {
      const { offerIds: ids, ...options } = req.body;
      const result = await deps.intelligence.rank(ids, options);
      const rankingToken = signRankingToken(
        {
          deals: result.ranked.map((d) => [d.offerId, d.rank, d.score]),
          mode: result.appliedMode,
          exp: Math.floor(Date.now() / 1000) + RANKING_TOKEN_TTL_SECONDS,
        },
        deps.rankingKey,
      );
      return { ...result, rankingToken };
    },
  );

  app.post(
    "/intelligence/ranking/compare",
    {
      config: noRateLimit,
      schema: { body: z.object({ offerIds: z.array(uuid).min(2).max(20), eligibility }).strict() },
    },
    async (req) => deps.intelligence.pricing.compare(req.body.offerIds, req.body.eligibility),
  );

  app.post(
    "/intelligence/match",
    { config: noRateLimit, schema: { body: matchRequestSchema } },
    async (req) => deps.matches.match(req.body),
  );

  app.post(
    "/intelligence/match/batch",
    { config: noRateLimit, schema: { body: matchBatchSchema } },
    async (req) => ({ results: await deps.matches.matchBatch(req.body.items) }),
  );

  app.get(
    "/intelligence/matches/:id",
    { config: noRateLimit, schema: { params: z.object({ id: uuid }) } },
    async (req) => {
      const match = await deps.reviews.getMatch(req.params.id);
      if (!match) throw AppError.notFound("Match");
      return match;
    },
  );

  app.post(
    "/intelligence/matches/:id/review",
    {
      config: noRateLimit,
      schema: { params: z.object({ id: uuid }), body: reviewRequestSchema },
    },
    async (req) => {
      // The service token alone (what the agent holds) is never enough to approve a merge.
      const header = req.headers[REVIEWER_CONTEXT_HEADER];
      const ctx =
        deps.reviewContextSecret && typeof header === "string"
          ? verifyReviewerContext(header, deps.reviewContextSecret)
          : null;
      if (!ctx) throw new AppError(ErrorCode.FORBIDDEN, "Signed human reviewer context required");
      if (ctx.matchId !== req.params.id)
        throw new AppError(ErrorCode.FORBIDDEN, "Reviewer context does not match this match");
      if (ctx.exp - Date.now() / 1000 > MAX_REVIEWER_CONTEXT_SECONDS)
        throw new AppError(ErrorCode.FORBIDDEN, "Reviewer context lifetime too long");
      if (!(await deps.reviews.getMatch(req.params.id))) throw AppError.notFound("Match");
      try {
        const result = await deps.reviews.review(req.params.id, req.body.resolution, {
          userId: ctx.reviewerUserId,
          ...(req.body.note ? { note: req.body.note } : {}),
        });
        req.log.info(
          { matchId: req.params.id, action: req.body.resolution.action },
          "match review resolved",
        );
        return { matchId: req.params.id, action: req.body.resolution.action, ...result };
      } catch (err) {
        if (err instanceof ReviewNotAllowedError)
          throw new AppError(ErrorCode.FORBIDDEN, err.message);
        if (err instanceof ReviewInputError) {
          if (/already been reviewed|No pending review/.test(err.message))
            throw AppError.conflict(err.message);
          throw new AppError(ErrorCode.VALIDATION_ERROR, err.message);
        }
        throw err;
      }
    },
  );

  app.get(
    "/searches/:id",
    { config: noRateLimit, schema: { params: z.object({ id: uuid }) } },
    async (req) => {
      const { userId } = await ownedSearch(req.headers[USER_CONTEXT_HEADER], req.params.id);
      const s = await prisma.search.findFirstOrThrow({ where: { id: req.params.id, userId } });
      return { id: s.id, userId: s.userId, query: s.query, filters: s.filters, status: s.status };
    },
  );

  app.post(
    "/searches/:id/events",
    {
      config: noRateLimit,
      schema: {
        params: z.object({ id: uuid }),
        body: z
          .object({
            type: z.enum([
              "node_started",
              "node_finished",
              "status",
              "sources_planned",
              "source_finished",
            ]),
            node: z.string().max(50).optional(),
            status: z.string().max(30).optional(),
            message: z.string().max(300).optional(),
            /** source_finished: one marketplace's outcome. */
            source: slug.optional(),
            resultCount: z.number().int().min(0).max(10_000).optional(),
            /** sources_planned: eligible and skipped marketplaces. */
            sources: z.array(slug).max(50).optional(),
            skipped: z.array(slug).max(50).optional(),
            at: z.string().max(40),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      await ownedSearch(req.headers[USER_CONTEXT_HEADER], req.params.id);
      const event = JSON.stringify(req.body);
      const log = searchEventsLog(deps.redisPrefix, req.params.id);
      await deps.redis
        .multi()
        .rpush(log, event)
        .ltrim(log, -200, -1)
        .expire(log, 3_600)
        .publish(searchEventsChannel(deps.redisPrefix, req.params.id), event)
        .exec();
      return reply.status(204).send();
    },
  );

  app.put(
    "/searches/:id/agent-result",
    { config: noRateLimit, schema: { params: z.object({ id: uuid }), body: agentResultSchema } },
    async (req) => {
      const { ctx, userId } = await ownedSearch(req.headers[USER_CONTEXT_HEADER], req.params.id);
      const body = req.body;
      const run = await prisma.agentRun.findFirst({
        where: { id: ctx.executionId, userId, searchId: req.params.id },
      });
      if (!run) throw AppError.notFound("Agent run");
      const search = await prisma.search.findFirstOrThrow({ where: { id: req.params.id, userId } });
      const terminal = [
        "COMPLETED",
        "PARTIAL",
        "FAILED",
        "NEEDS_CLARIFICATION",
        "CANCELLED",
      ].includes(search.status);
      if (terminal && run.finishedAt === null) {
        // Another execution already finished this search; never overwrite it.
        throw AppError.conflict("Search already finished by another execution");
      }
      // Prices at search time come from the database, never from the agent.
      const offers = await prisma.productOffer.findMany({
        where: { id: { in: body.rankedDeals.map((d) => d.offerId) } },
        select: { id: true, sellingPricePaise: true, mrpPaise: true },
      });
      const byId = new Map(offers.map((o) => [o.id, o]));
      // Rank and score must come from the TypeScript ranking engine, not the agent.
      if (body.rankedDeals.length) {
        const signed = body.rankingToken
          ? verifyRankingToken(body.rankingToken, deps.rankingKey)
          : null;
        if (!signed || !matchesRanking(body.rankedDeals, signed)) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Ranked deals must match a ranking computed by /intelligence/ranking/rank",
          );
        }
      }
      const missing = body.rankedDeals.filter((d) => !byId.has(d.offerId));
      if (missing.length)
        throw new AppError(ErrorCode.VALIDATION_ERROR, `Unknown offers: ${missing.length}`);
      const sources = await prisma.shoppingSource.findMany({
        where: { slug: { in: body.sourceRuns.map((r) => r.sourceId) } },
        select: { id: true, slug: true },
      });
      const sourceId = new Map(sources.map((s) => [s.slug, s.id]));
      const finishedAt = new Date();
      const output = {
        response: body.response,
        clarificationQuestion: body.clarificationQuestion,
        warnings: body.warnings,
        status: body.status,
      };
      await prisma.$transaction([
        prisma.searchResult.deleteMany({ where: { searchId: search.id } }),
        prisma.searchSourceRun.deleteMany({ where: { searchId: search.id } }),
        prisma.searchSourceRun.createMany({
          data: body.sourceRuns
            .filter((r) => sourceId.has(r.sourceId))
            .map((r) => ({
              userId,
              searchId: search.id,
              sourceId: sourceId.get(r.sourceId)!,
              status: r.status,
              resultCount: r.resultCount,
              durationMs: r.durationMs,
              errorCode: r.errorCode,
              errorMessage: r.errorMessage,
            })),
        }),
        prisma.searchResult.createMany({
          data: body.rankedDeals.map((d) => ({
            userId,
            searchId: search.id,
            offerId: d.offerId,
            rank: d.rank,
            score: d.score,
            pricePaiseAtSearch: byId.get(d.offerId)!.sellingPricePaise,
            mrpPaiseAtSearch: byId.get(d.offerId)!.mrpPaise,
            explanation: d.explanation,
          })),
        }),
        prisma.search.update({
          where: { id: search.id },
          data: {
            status: body.status,
            completedAt: finishedAt,
            ...(body.interpretation ? { intent: toJson(body.interpretation) } : {}),
          },
        }),
        prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: AGENT_STATUS[body.status],
            output,
            error: body.agentRun.error,
            provider: body.agentRun.provider,
            model: body.agentRun.model,
            inputTokens: body.agentRun.inputTokens,
            outputTokens: body.agentRun.outputTokens,
            durationMs: body.agentRun.durationMs,
            metadata: toJson(body.agentRun.metadata),
            finishedAt,
          },
        }),
      ]);
      const event = JSON.stringify({
        type: "status",
        status: body.status,
        at: finishedAt.toISOString(),
      });
      await deps.redis
        .publish(searchEventsChannel(deps.redisPrefix, search.id), event)
        .catch(() => undefined);
      return { saved: true, results: body.rankedDeals.length, sourceRuns: body.sourceRuns.length };
    },
  );
};
