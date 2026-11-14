/**
 * Read-only platform administration: shopping-source configuration and the
 * audit log. ADMIN role required on every route (checked server-side).
 * Source enable/disable arrives with the connector registry (Phase 3), since
 * enabling a source without an authorized connector would be meaningless.
 */
import type { PrismaClient } from "@dealmind/db";
import { pageQuery, paginationOf } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { iso, ok, page, paginated } from "../../utils/http.js";

const security = [{ sessionCookie: [] }];

const adminSource = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  domain: z.string(),
  baseUrl: z.string(),
  integrationKind: z.string(),
  status: z.enum(["ACTIVE", "DISABLED", "MAINTENANCE"]),
  isSample: z.boolean(),
  affiliateEnabled: z.boolean(),
  timeoutMs: z.number().int(),
  rateLimitPerMinute: z.number().int(),
  maxRetries: z.number().int(),
  health: z.string(),
  lastHealthCheckAt: z.string().nullable(),
  lastHealthError: z.string().nullable(),
});

const auditEntry = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
});

export const adminPlatformRoutes: FastifyPluginAsyncZod<{ prisma: PrismaClient }> = async (
  app,
  { prisma },
) => {
  app.addHook("preHandler", app.requireAdmin);

  app.get(
    "/sources",
    {
      schema: {
        tags: ["admin"],
        summary: "All shopping sources with configuration (no credentials)",
        security,
        response: { 200: ok(z.array(adminSource)) },
      },
    },
    async () =>
      (await prisma.shoppingSource.findMany({ orderBy: { name: "asc" } })).map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        domain: s.domain,
        baseUrl: s.baseUrl,
        integrationKind: s.integrationKind,
        status: s.status,
        isSample: s.isSample,
        affiliateEnabled: s.affiliateEnabled,
        timeoutMs: s.timeoutMs,
        rateLimitPerMinute: s.rateLimitPerMinute,
        maxRetries: s.maxRetries,
        health: s.health,
        lastHealthCheckAt: iso(s.lastHealthCheckAt),
        lastHealthError: s.lastHealthError,
      })),
  );

  app.get(
    "/audit-logs",
    {
      schema: {
        tags: ["admin"],
        summary: "Audit log of sensitive actions, newest first",
        security,
        querystring: pageQuery
          .extend({ action: z.string().trim().min(1).max(100).optional() })
          .strict(),
        response: { 200: page(auditEntry) },
      },
    },
    async (req) => {
      const where = req.query.action ? { action: req.query.action } : {};
      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (req.query.page - 1) * req.query.pageSize,
          take: req.query.pageSize,
        }),
        prisma.auditLog.count({ where }),
      ]);
      return paginated(
        rows.map((r) => ({
          id: r.id,
          actorId: r.actorId,
          action: r.action,
          entity: r.entity,
          entityId: r.entityId,
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
          createdAt: r.createdAt.toISOString(),
        })),
        paginationOf(req.query, total),
      );
    },
  );
};
