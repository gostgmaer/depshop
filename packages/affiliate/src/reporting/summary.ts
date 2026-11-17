/**
 * Affiliate analytics from recorded data only. Clicks are counted; money is
 * only what partners reported: PENDING = reported but unconfirmed
 * ("estimated" by the partner), APPROVED = confirmed, REVERSED/REJECTED =
 * clawed back or never paid. Nothing is extrapolated from clicks. Affiliate
 * figures are separate from subscription billing.
 */
import type { PrismaClient } from "@dealmind/db";

export interface AffiliateSummary {
  from: string;
  to: string;
  clicks: {
    total: number;
    blocked: number;
    signedIn: number;
    bySource: { slug: string; name: string; clicks: number }[];
    byCategory: { category: string; clicks: number }[];
    byProvider: Record<string, number>;
  };
  conversions: Record<
    "PENDING" | "APPROVED" | "REJECTED" | "REVERSED",
    { count: number; commissionPaise: number; orderAmountPaise: number }
  >;
  payouts: Record<"PENDING" | "PAID" | "FAILED", { count: number; amountPaise: number }>;
}

export async function affiliateSummary(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
): Promise<AffiliateSummary> {
  const createdAt = { gte: range.from, lt: range.to };
  const [total, blocked, signedIn, bySource, byProvider, byCategory, conv, pay] = await Promise.all(
    [
      prisma.affiliateClick.count({ where: { createdAt } }),
      prisma.affiliateClick.count({ where: { createdAt, redirectStatus: "BLOCKED" } }),
      prisma.affiliateClick.count({ where: { createdAt, userId: { not: null } } }),
      prisma.affiliateClick.groupBy({
        by: ["sourceId"],
        where: { createdAt, redirectStatus: "REDIRECTED" },
        _count: { _all: true },
      }),
      prisma.affiliateClick.groupBy({
        by: ["provider"],
        where: { createdAt, redirectStatus: "REDIRECTED" },
        _count: { _all: true },
      }),
      prisma.$queryRaw<{ category: string; clicks: bigint }[]>`
      SELECT COALESCE(c."name", 'Uncategorized') AS category, COUNT(*)::bigint AS clicks
      FROM "AffiliateClick" k
      LEFT JOIN "Product" p ON p."id" = k."productId"
      LEFT JOIN "Category" c ON c."id" = p."categoryId"
      WHERE k."createdAt" >= ${range.from} AND k."createdAt" < ${range.to} AND k."redirectStatus" = 'REDIRECTED'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      prisma.affiliateConversion.groupBy({
        by: ["status"],
        where: { reportedAt: { gte: range.from, lt: range.to } },
        _count: { _all: true },
        _sum: { commissionPaise: true, orderAmountPaise: true },
      }),
      prisma.affiliatePayout.groupBy({
        by: ["status"],
        where: { createdAt },
        _count: { _all: true },
        _sum: { amountPaise: true },
      }),
    ],
  );
  const sources = await prisma.shoppingSource.findMany({
    where: { id: { in: bySource.map((s) => s.sourceId) } },
    select: { id: true, slug: true, name: true },
  });
  const conversions = Object.fromEntries(
    (["PENDING", "APPROVED", "REJECTED", "REVERSED"] as const).map((s) => {
      const r = conv.find((c) => c.status === s);
      return [
        s,
        {
          count: r?._count._all ?? 0,
          commissionPaise: Number(r?._sum.commissionPaise ?? 0n),
          orderAmountPaise: Number(r?._sum.orderAmountPaise ?? 0n),
        },
      ];
    }),
  ) as AffiliateSummary["conversions"];
  const payouts = Object.fromEntries(
    (["PENDING", "PAID", "FAILED"] as const).map((s) => {
      const r = pay.find((p) => p.status === s);
      return [s, { count: r?._count._all ?? 0, amountPaise: Number(r?._sum.amountPaise ?? 0n) }];
    }),
  ) as AffiliateSummary["payouts"];
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    clicks: {
      total,
      blocked,
      signedIn,
      bySource: bySource
        .map((s) => {
          const src = sources.find((x) => x.id === s.sourceId);
          return {
            slug: src?.slug ?? "unknown",
            name: src?.name ?? "Unknown",
            clicks: s._count._all,
          };
        })
        .sort((a, b) => b.clicks - a.clicks),
      byCategory: byCategory.map((c) => ({ category: c.category, clicks: Number(c.clicks) })),
      byProvider: Object.fromEntries(byProvider.map((p) => [p.provider, p._count._all])),
    },
    conversions,
    payouts,
  };
}
