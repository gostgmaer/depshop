/**
 * Platform admin console API (/api/v1/admin/*). ADMIN role checked on every
 * request in `onRequest` (before body validation: non-admins learn nothing).
 * Every change is audited with the admin, target, request id, reason and
 * before/after values; secrets are never read into responses or audit logs.
 */
import { effectivePlan } from "@dealmind/billing";
import type { PrismaClient } from "@dealmind/db";
import type { QueueName } from "@dealmind/queue";
import {
  AppError,
  ErrorCode,
  adminAuditEntry,
  adminDashboardView,
  adminJobsView,
  adminReasonInput,
  adminSourceUpdateInput,
  adminSourceView,
  adminUserDetail,
  aiModelConfigInput,
  aiModelConfigView,
  aiUsageView,
  pageQuery,
  paginationOf,
  searchAnalyticsView,
  subscriptionAnalyticsView,
} from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";
import { ok, page, paginated } from "../../utils/http.js";
import type { SessionService } from "../auth/session-service.js";
import { recordAudit } from "../users/audit.js";
import { type AdminConsoleService, ADMIN_QUEUES } from "./admin-console-service.js";

const security = [{ sessionCookie: [] }];
const idParam = z.object({ id: z.string().uuid() });
/** The AI configuration the agent uses for its LLM calls. */
export const AGENT_AI_PURPOSE = "INTENT_EXTRACTION" as const;

export interface AdminConsoleOptions {
  prisma: PrismaClient;
  console: AdminConsoleService;
  sessions: SessionService;
  redis: Redis;
  redisPrefix: string;
  /** Agent service health (GET /health) — provider/model names only. */
  agentHealth: (() => Promise<Record<string, unknown>>) | null;
  /** Agent defaults from its environment are unknown here; shown via agentHealth. */
  enqueueHealthCheck: () => Promise<string>;
}

async function audit(
  prisma: PrismaClient,
  req: FastifyRequest,
  e: {
    action: string;
    entity: string;
    entityId: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  },
) {
  await recordAudit(prisma, {
    actorId: getAuth(req).userId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId,
    metadata: JSON.parse(
      JSON.stringify({
        requestId: req.id,
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.before !== undefined ? { before: e.before } : {}),
        ...(e.after !== undefined ? { after: e.after } : {}),
      }),
    ) as Record<string, never>,
  });
}

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export const adminConsoleRoutes: FastifyPluginAsyncZod<AdminConsoleOptions> = async (app, o) => {
  const { prisma } = o;
  app.addHook("onRequest", app.requireAdmin);

  // ── Dashboard ──
  app.get(
    "/dashboard",
    {
      schema: {
        tags: ["admin"],
        summary: "Platform overview (real data only)",
        security,
        response: { 200: ok(adminDashboardView) },
      },
    },
    async (req) => {
      // Administrative access event: at most once per hour per admin.
      const key = `${o.redisPrefix}:admin:access:${getAuth(req).userId}`;
      if ((await o.redis.set(key, "1", "EX", 3_600, "NX").catch(() => null)) === "OK")
        await audit(prisma, req, {
          action: "admin.console_accessed",
          entity: "User",
          entityId: getAuth(req).userId,
        });
      return o.console.dashboard();
    },
  );

  // ── Users ──
  app.get(
    "/users/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "User profile, subscription and usage (no credentials)",
        security,
        params: idParam,
        response: { 200: ok(adminUserDetail) },
      },
    },
    async (req) => {
      const u = await o.console.userDetail(req.params.id);
      if (!u) throw AppError.notFound("User");
      return u;
    },
  );

  const setStatus =
    (status: "ACTIVE" | "SUSPENDED", action: string) =>
    async (req: FastifyRequest<{ Params: { id: string }; Body: { reason: string } }>) => {
      const actor = getAuth(req).userId;
      if (req.params.id === actor)
        throw AppError.forbidden("Admins cannot change their own status");
      const before = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { status: true },
      });
      if (!before) throw AppError.notFound("User");
      if (before.status !== status) {
        await prisma.user.update({ where: { id: req.params.id }, data: { status } });
        // DealMind sessions end on suspension; the shared IAM account isn't touched.
        if (status === "SUSPENDED") await o.sessions.revokeAllForUser(req.params.id);
        await audit(prisma, req, {
          action,
          entity: "User",
          entityId: req.params.id,
          reason: req.body.reason,
          before,
          after: { status },
        });
      }
      return (await o.console.userDetail(req.params.id))!;
    };
  const actionSchema = (summary: string) => ({
    schema: {
      tags: ["admin"],
      summary,
      security,
      params: idParam,
      body: adminReasonInput,
      response: { 200: ok(adminUserDetail) },
    },
  });
  app.post(
    "/users/:id/suspend",
    actionSchema("Suspend a user (signs out their DealMind sessions)"),
    setStatus("SUSPENDED", "admin.user_suspended"),
  );
  app.post(
    "/users/:id/reactivate",
    actionSchema("Reactivate a suspended user"),
    setStatus("ACTIVE", "admin.user_reactivated"),
  );
  app.post(
    "/users/:id/sessions/revoke",
    actionSchema("Sign a user out of every DealMind session"),
    async (req) => {
      if (!(await prisma.user.count({ where: { id: req.params.id } })))
        throw AppError.notFound("User");
      const revoked = await o.sessions.revokeAllForUser(req.params.id);
      await audit(prisma, req, {
        action: "admin.user_sessions_revoked",
        entity: "User",
        entityId: req.params.id,
        reason: req.body.reason,
        after: { revoked: revoked.length },
      });
      return (await o.console.userDetail(req.params.id))!;
    },
  );

  // ── Sources / connectors ──
  app.get(
    "/sources",
    {
      schema: {
        tags: ["admin"],
        summary: "Sources with connector readiness (credential names only), health and metrics",
        security,
        response: { 200: ok(z.array(adminSourceView)) },
      },
    },
    async () => o.console.sources(),
  );
  app.patch(
    "/sources/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Enable/disable a source or update non-secret settings",
        security,
        params: idParam,
        body: adminSourceUpdateInput,
        response: { 200: ok(adminSourceView) },
      },
    },
    async (req) => {
      const s = await prisma.shoppingSource.findUnique({ where: { id: req.params.id } });
      if (!s) throw AppError.notFound("Source");
      const { reason, ...changes } = req.body;
      if (!reason) throw new AppError(ErrorCode.VALIDATION_ERROR, "A reason is required");
      if (changes.status === "ACTIVE" && s.status !== "ACTIVE") {
        // Never mark a connector live without a ready, authorized integration.
        const c = o.console.readiness(s.slug);
        if (!s.isSample) {
          if (!c.registered)
            throw new AppError(ErrorCode.CONFLICT, "No connector is registered for this source.");
          // Only a READY connector may go live (PENDING_APPROVAL = no authorized integration).
          if (c.state === "PENDING_CREDENTIALS")
            throw new AppError(ErrorCode.CONFLICT, `Missing credentials: ${c.missing.join(", ")}`);
          if (c.state !== "READY")
            throw new AppError(
              ErrorCode.CONFLICT,
              `This connector is ${c.state}${c.reason ? `: ${c.reason}` : ""}. It can't be enabled until the integration is authorized.`,
            );
        }
        if (s.status === "PENDING_APPROVAL" || s.status === "PENDING_CREDENTIALS")
          throw new AppError(
            ErrorCode.CONFLICT,
            `This source is ${s.status}; it can't be enabled until the integration is approved and verified.`,
          );
      }
      const before = {
        status: s.status,
        timeoutMs: s.timeoutMs,
        rateLimitPerMinute: s.rateLimitPerMinute,
        maxRetries: s.maxRetries,
        cacheTtlSeconds: s.cacheTtlSeconds,
        trackingEnabled: s.trackingEnabled,
      };
      await prisma.shoppingSource.update({ where: { id: s.id }, data: changes });
      await audit(prisma, req, {
        action: "admin.source_updated",
        entity: "ShoppingSource",
        entityId: s.id,
        reason,
        before: Object.fromEntries(
          Object.keys(changes).map((k) => [k, before[k as keyof typeof before]]),
        ),
        after: changes,
      });
      return (await o.console.sources()).find((x) => x.id === s.id)!;
    },
  );
  app.post(
    "/sources/health-check",
    {
      schema: {
        tags: ["admin"],
        summary: "Queue a connector health check of every source (worker)",
        security,
        body: adminReasonInput,
      },
    },
    async (req) => {
      const jobId = await o.enqueueHealthCheck();
      await audit(prisma, req, {
        action: "admin.health_check_requested",
        entity: "ShoppingSource",
        entityId: "*",
        reason: req.body.reason,
        after: { jobId },
      });
      return { queued: true, jobId };
    },
  );

  // ── AI models ──
  const viewAi = (row: Awaited<ReturnType<typeof prisma.aiModelConfig.findUnique>>) =>
    row
      ? {
          purpose: row.purpose,
          provider: row.provider as "google" | "openai" | "rules",
          model: row.model,
          temperature: row.temperature,
          maxTokens: row.maxTokens,
          enabled: row.enabled,
          fallbackProvider: (row.fallbackProvider as "google" | "openai" | "rules" | null) ?? null,
          fallbackModel: row.fallbackModel,
          monthlyTokenLimit: row.monthlyTokenLimit,
          inputPaisePerMillionTokens:
            row.inputPaisePerMillionTokens === null ? null : Number(row.inputPaisePerMillionTokens),
          outputPaisePerMillionTokens:
            row.outputPaisePerMillionTokens === null
              ? null
              : Number(row.outputPaisePerMillionTokens),
          updatedAt: row.updatedAt.toISOString(),
          stored: true,
        }
      : {
          purpose: AGENT_AI_PURPOSE,
          provider: "rules" as const,
          model: "",
          temperature: 0.2,
          maxTokens: 8192,
          enabled: true,
          fallbackProvider: null,
          fallbackModel: null,
          monthlyTokenLimit: null,
          inputPaisePerMillionTokens: null,
          outputPaisePerMillionTokens: null,
          updatedAt: null,
          stored: false,
        };

  const usage = async () => {
    const row = await prisma.aiModelConfig.findUnique({ where: { purpose: AGENT_AI_PURPOSE } });
    const since = monthStart(new Date());
    const [byModel, failed] = await Promise.all([
      prisma.agentRun.groupBy({
        by: ["provider", "model"],
        where: { startedAt: { gte: since } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      prisma.agentRun.count({ where: { startedAt: { gte: since }, status: "FAILED" } }),
    ]);
    const inTok = byModel.reduce((n, m) => n + (m._sum.inputTokens ?? 0), 0);
    const outTok = byModel.reduce((n, m) => n + (m._sum.outputTokens ?? 0), 0);
    const priced =
      row && (row.inputPaisePerMillionTokens !== null || row.outputPaisePerMillionTokens !== null);
    return {
      month: since.toISOString().slice(0, 7),
      runs: byModel.reduce((n, m) => n + m._count._all, 0),
      failedRuns: failed,
      inputTokens: inTok,
      outputTokens: outTok,
      byModel: byModel.map((m) => ({
        provider: m.provider || "unknown",
        model: m.model || "unknown",
        runs: m._count._all,
        inputTokens: m._sum.inputTokens ?? 0,
        outputTokens: m._sum.outputTokens ?? 0,
      })),
      estimatedCostPaise: priced
        ? // BigInt: tokens × paise-per-million can exceed 2^53; rounded half-up to whole paise.
          Number(
            (BigInt(inTok) * (row.inputPaisePerMillionTokens ?? 0n) +
              BigInt(outTok) * (row.outputPaisePerMillionTokens ?? 0n) +
              500_000n) /
              1_000_000n,
          )
        : null,
      limitReached: row?.monthlyTokenLimit != null && inTok + outTok >= row.monthlyTokenLimit,
    };
  };

  app.get(
    "/ai-models",
    {
      schema: {
        tags: ["admin"],
        summary: "Agent LLM configuration (no API keys) and this month's usage",
        security,
      },
    },
    async () => {
      const row = await prisma.aiModelConfig.findUnique({ where: { purpose: AGENT_AI_PURPOSE } });
      return {
        config: aiModelConfigView.parse(viewAi(row)),
        usage: aiUsageView.parse(await usage()),
      };
    },
  );
  app.put(
    "/ai-models",
    {
      schema: {
        tags: ["admin"],
        summary: "Set the agent LLM configuration (applied by the agent within a minute)",
        security,
        body: aiModelConfigInput,
      },
    },
    async (req) => {
      const { reason, ...input } = req.body;
      const before = await prisma.aiModelConfig.findUnique({
        where: { purpose: AGENT_AI_PURPOSE },
      });
      const data = {
        ...input,
        fallbackModel: input.fallbackProvider ? input.fallbackModel : null,
        updatedById: getAuth(req).userId,
      };
      const row = await prisma.aiModelConfig.upsert({
        where: { purpose: AGENT_AI_PURPOSE },
        create: { purpose: AGENT_AI_PURPOSE, ...data },
        update: data,
      });
      await audit(prisma, req, {
        action: "admin.ai_model_updated",
        entity: "AiModelConfig",
        entityId: row.id,
        reason,
        before: before ? viewAi(before) : null,
        after: viewAi(row),
      });
      return {
        config: aiModelConfigView.parse(viewAi(row)),
        usage: aiUsageView.parse(await usage()),
      };
    },
  );
  app.post(
    "/ai-models/health",
    {
      schema: {
        tags: ["admin"],
        summary: "Agent service health: provider and model in use (names only)",
        security,
      },
    },
    async () => {
      if (!o.agentHealth) return { status: "not_configured" as const };
      try {
        return { status: "ok" as const, agent: await o.agentHealth() };
      } catch (err) {
        return { status: "fail" as const, error: (err as Error).message.slice(0, 200) };
      }
    },
  );

  // ── Analytics ──
  app.get(
    "/analytics",
    {
      schema: {
        tags: ["admin"],
        summary: "Search analytics (k-anonymous query lists: no user ids, no rare queries)",
        security,
        querystring: z
          .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
          .strict(),
        response: { 200: ok(searchAnalyticsView) },
      },
    },
    async (req) => o.console.searchAnalytics(req.query.days),
  );
  app.get(
    "/subscriptions",
    {
      schema: {
        tags: ["admin"],
        summary: "Subscription analytics (DealMind mirror; estimates labelled)",
        security,
        response: { 200: ok(subscriptionAnalyticsView) },
      },
    },
    async () => o.console.subscriptionAnalytics(),
  );
  app.get(
    "/subscriptions/users",
    {
      schema: {
        tags: ["admin"],
        summary: "Paid subscriptions (for support inspection)",
        security,
        querystring: pageQuery
          .extend({
            status: z
              .enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED", "PAUSED"])
              .optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const where = {
        planCode: { not: "FREE" as const },
        ...(req.query.status ? { status: req.query.status } : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.subscription.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: (req.query.page - 1) * req.query.pageSize,
          take: req.query.pageSize,
          include: { user: { select: { id: true, email: true } } },
        }),
        prisma.subscription.count({ where }),
      ]);
      const now = new Date();
      return paginated(
        rows.map((s) => ({
          userId: s.user.id,
          email: s.user.email,
          plan: s.planCode,
          effectivePlan: effectivePlan(s, now).plan,
          status: s.status,
          interval: s.interval,
          currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
        })),
        paginationOf(req.query, total),
      );
    },
  );

  // ── Jobs ──
  app.get(
    "/jobs",
    {
      schema: {
        tags: ["admin"],
        summary: "Queues, recent failures (no payloads) and dead letters",
        security,
        response: { 200: ok(adminJobsView) },
      },
    },
    async () => o.console.jobs(),
  );
  app.post(
    "/jobs/:id/retry",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Retry ONE failed job (no bulk operations)",
        security,
        params: z.object({ id: z.string().min(1).max(300) }),
        body: z
          .object({
            queue: z.enum(ADMIN_QUEUES as [QueueName, ...QueueName[]]),
            reason: z.string().trim().min(3).max(500),
          })
          .strict(),
      },
    },
    async (req) => {
      const r = await o.console.retryJob(req.body.queue, req.params.id);
      if (r === "not-found") throw AppError.notFound("Job");
      if (r === "not-failed")
        throw new AppError(ErrorCode.CONFLICT, "Only failed jobs can be retried.");
      await audit(prisma, req, {
        action: "admin.job_retried",
        entity: "Job",
        entityId: `${req.body.queue}:${req.params.id}`,
        reason: req.body.reason,
      });
      return { retried: true };
    },
  );

  // ── System ──
  app.get(
    "/system",
    { schema: { tags: ["admin"], summary: "Dependency checks and queue state", security } },
    async () => ({
      checks: await o.console.runChecks(),
      queues: await o.console.queues(),
      at: new Date().toISOString(),
    }),
  );

  // ── Catalog ──
  app.get(
    "/products",
    {
      schema: {
        tags: ["admin"],
        summary: "Products (search by name, brand or id)",
        security,
        querystring: pageQuery
          .extend({
            q: z.string().trim().min(1).max(100).optional(),
            active: z
              .enum(["true", "false"])
              .transform((v) => v === "true")
              .optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const where = o.console.productWhere(req.query.q, req.query.active);
      const [rows, total] = await Promise.all([
        prisma.product.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: (req.query.page - 1) * req.query.pageSize,
          take: req.query.pageSize,
          select: {
            id: true,
            name: true,
            brand: true,
            isActive: true,
            updatedAt: true,
            category: { select: { name: true } },
            _count: { select: { variants: true, offers: true } },
          },
        }),
        prisma.product.count({ where }),
      ]);
      return paginated(
        rows.map((p) => ({
          id: p.id,
          name: p.name,
          brand: p.brand,
          isActive: p.isActive,
          category: p.category?.name ?? null,
          variants: p._count.variants,
          offers: p._count.offers,
          updatedAt: p.updatedAt.toISOString(),
        })),
        paginationOf(req.query, total),
      );
    },
  );
  app.get(
    "/products/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Product with variants and offers (provenance)",
        security,
        params: idParam,
      },
    },
    async (req) => {
      const p = await prisma.product.findUnique({
        where: { id: req.params.id },
        include: {
          category: { select: { id: true, name: true } },
          variants: {
            select: {
              id: true,
              variantKey: true,
              attributes: true,
              sku: true,
              gtin: true,
              mpn: true,
            },
          },
          offers: {
            orderBy: { observedAt: "desc" },
            select: {
              id: true,
              variantId: true,
              title: true,
              productUrl: true,
              sellingPricePaise: true,
              mrpPaise: true,
              stockStatus: true,
              observedAt: true,
              matchMethod: true,
              matchConfidence: true,
              trackingState: true,
              source: { select: { slug: true, name: true, isSample: true } },
            },
          },
        },
      });
      if (!p) throw AppError.notFound("Product");
      return {
        id: p.id,
        name: p.name,
        brand: p.brand,
        isActive: p.isActive,
        category: p.category,
        variants: p.variants,
        offers: p.offers.map((x) => ({
          ...x,
          sellingPricePaise: Number(x.sellingPricePaise),
          mrpPaise: x.mrpPaise === null ? null : Number(x.mrpPaise),
          observedAt: x.observedAt.toISOString(),
        })),
      };
    },
  );
  app.patch(
    "/products/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Manual correction or (de)activation; offers and their provenance are untouched",
        security,
        params: idParam,
        body: z
          .object({
            isActive: z.boolean(),
            name: z.string().trim().min(2).max(300),
            brand: z.string().trim().min(1).max(100),
            categoryId: z.string().uuid().nullable(),
            reason: z.string().trim().min(3).max(500),
          })
          .partial()
          .strict()
          .refine(
            (v) => typeof v.reason === "string" && Object.keys(v).length > 1,
            "A reason and at least one change are required",
          ),
      },
    },
    async (req) => {
      const { reason, ...changes } = req.body;
      const before = await prisma.product.findUnique({
        where: { id: req.params.id },
        select: { isActive: true, name: true, brand: true, categoryId: true },
      });
      if (!before) throw AppError.notFound("Product");
      if (
        changes.categoryId &&
        !(await prisma.category.count({ where: { id: changes.categoryId } }))
      )
        throw AppError.notFound("Category");
      const after = await prisma.product.update({
        where: { id: req.params.id },
        data: changes,
        select: { id: true, isActive: true, name: true, brand: true, categoryId: true },
      });
      await audit(prisma, req, {
        action: "admin.product_corrected",
        entity: "Product",
        entityId: after.id,
        reason: reason!,
        before: Object.fromEntries(
          Object.keys(changes).map((k) => [k, before[k as keyof typeof before]]),
        ),
        after: changes,
      });
      return after;
    },
  );
  app.get(
    "/categories",
    { schema: { tags: ["admin"], summary: "Category tree with product counts", security } },
    async () =>
      (
        await prisma.category.findMany({
          orderBy: [{ parentId: "asc" }, { name: "asc" }],
          select: {
            id: true,
            slug: true,
            name: true,
            parentId: true,
            isActive: true,
            _count: { select: { products: true } },
          },
        })
      ).map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        parentId: c.parentId,
        isActive: c.isActive,
        products: c._count.products,
      })),
  );
  app.patch(
    "/categories/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Rename or (de)activate a category",
        security,
        params: idParam,
        body: z
          .object({
            name: z.string().trim().min(2).max(100),
            isActive: z.boolean(),
            reason: z.string().trim().min(3).max(500),
          })
          .partial()
          .strict()
          .refine(
            (v) => typeof v.reason === "string" && Object.keys(v).length > 1,
            "A reason and at least one change are required",
          ),
      },
    },
    async (req) => {
      const { reason, ...changes } = req.body;
      const before = await prisma.category.findUnique({
        where: { id: req.params.id },
        select: { name: true, isActive: true },
      });
      if (!before) throw AppError.notFound("Category");
      const after = await prisma.category.update({
        where: { id: req.params.id },
        data: changes,
        select: { id: true, name: true, isActive: true },
      });
      await audit(prisma, req, {
        action: "admin.category_updated",
        entity: "Category",
        entityId: after.id,
        reason: reason!,
        before: Object.fromEntries(
          Object.keys(changes).map((k) => [k, before[k as keyof typeof before]]),
        ),
        after: changes,
      });
      return after;
    },
  );

  // ── Audit log ──
  app.get(
    "/audit-logs",
    {
      schema: {
        tags: ["admin"],
        summary: "Audit log, newest first (filter by action prefix, entity or actor)",
        security,
        querystring: pageQuery
          .extend({
            action: z.string().trim().min(1).max(100).optional(),
            entity: z.string().trim().min(1).max(60).optional(),
            actorId: z.string().uuid().optional(),
          })
          .strict(),
        response: { 200: page(adminAuditEntry) },
      },
    },
    async (req) => {
      const q = req.query;
      const where = {
        ...(q.action ? { action: { startsWith: q.action } } : {}),
        ...(q.entity ? { entity: q.entity } : {}),
        ...(q.actorId ? { actorId: q.actorId } : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
          include: { actor: { select: { email: true } } },
        }),
        prisma.auditLog.count({ where }),
      ]);
      return paginated(
        rows.map((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          return {
            id: r.id,
            actorId: r.actorId,
            actorEmail: r.actor?.email ?? null,
            action: r.action,
            entity: r.entity,
            entityId: r.entityId,
            requestId: typeof meta.requestId === "string" ? meta.requestId : null,
            metadata: meta,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        paginationOf(q, total),
      );
    },
  );
};
