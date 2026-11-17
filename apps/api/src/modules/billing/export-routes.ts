/**
 * GET /api/v1/exports/:kind — CSV export of the caller's own data
 * (watchlists, alerts, searches). A plan feature with a monthly limit: the
 * usage is consumed atomically before the file is built. Prices are integer
 * paise, also shown as rupees; values are CSV-escaped and formula-safe.
 */
import type { EntitlementService } from "@dealmind/billing";
import type { PrismaClient } from "@dealmind/db";
import { formatPaise } from "@dealmind/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAuth } from "../../plugins/auth.js";

const MAX_ROWS = 10_000;

/** RFC 4180 quoting; cells starting with = + - @ are prefixed so spreadsheets don't run them. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (header: string[], rows: (string | number | null | undefined)[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const rupees = (p: bigint | null) => (p === null ? "" : formatPaise(Number(p)));

export const exportRoutes: FastifyPluginAsyncZod<{
  prisma: PrismaClient;
  entitlements: EntitlementService;
}> = async (app, { prisma, entitlements }) => {
  app.get(
    "/:kind",
    {
      preHandler: app.requireAuth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["billing"],
        summary: "Export your watchlists, alerts or searches as CSV (plan feature)",
        security: [{ sessionCookie: [] }],
        params: z.object({ kind: z.enum(["watchlists.csv", "alerts.csv", "searches.csv"]) }),
      },
    },
    async (req, reply) => {
      const userId = getAuth(req).userId;
      await entitlements.requireFeature(userId, "exports", "Exports");
      const kind = req.params.kind.replace(".csv", "");
      const body = await prisma.$transaction(async (tx) => {
        await entitlements.consumeUsage(tx, userId, "exports");
        if (kind === "watchlists") {
          const items = await tx.watchlistItem.findMany({
            where: { userId },
            include: {
              watchlist: { select: { name: true } },
              variant: {
                select: { attributes: true, product: { select: { name: true, brand: true } } },
              },
            },
            orderBy: { addedAt: "asc" },
            take: MAX_ROWS,
          });
          return csv(
            ["watchlist", "brand", "product", "variant", "note", "added_at"],
            items.map((i) => [
              i.watchlist.name,
              i.variant.product.brand,
              i.variant.product.name,
              Object.values((i.variant.attributes ?? {}) as Record<string, unknown>).join(" / "),
              i.note,
              i.addedAt.toISOString(),
            ]),
          );
        }
        if (kind === "alerts") {
          const alerts = await tx.priceAlert.findMany({
            where: { userId },
            include: {
              variant: { select: { product: { select: { name: true } } } },
              source: { select: { name: true } },
            },
            orderBy: { createdAt: "asc" },
            take: MAX_ROWS,
          });
          return csv(
            [
              "product",
              "type",
              "status",
              "target_paise",
              "target",
              "marketplace",
              "trigger_count",
              "created_at",
            ],
            alerts.map((a) => [
              a.variant.product.name,
              a.type,
              a.status,
              a.targetPricePaise?.toString() ?? "",
              rupees(a.targetPricePaise),
              a.source?.name ?? "any",
              a.triggerCount,
              a.createdAt.toISOString(),
            ]),
          );
        }
        const searches = await tx.search.findMany({
          where: { userId },
          select: {
            query: true,
            status: true,
            createdAt: true,
            _count: { select: { results: true } },
          },
          orderBy: { createdAt: "asc" },
          take: MAX_ROWS,
        });
        return csv(
          ["query", "status", "results", "created_at"],
          searches.map((s) => [s.query, s.status, s._count.results, s.createdAt.toISOString()]),
        );
      });
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="dealmind-${kind}.csv"`)
        .header("cache-control", "no-store")
        .send(body);
    },
  );
};
