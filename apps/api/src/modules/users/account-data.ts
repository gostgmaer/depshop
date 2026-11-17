/**
 * Personal data export (Phase 7.1, privacy): everything DealMind stores that
 * belongs to one user, as JSON. Scoped ONLY by the authenticated user's id.
 *
 * Deliberately omitted (security material, not personal content):
 * session token hashes and session family ids, encrypted IAM tokens, push
 * subscription encryption keys (p256dh/auth), and the salted IP hash on
 * affiliate clicks. Passwords are never held by DealMind (shared IAM).
 */
import type { PrismaClient } from "@dealmind/db";

/** Caps keep a single export bounded; the export says when a list was capped. */
const CAP = 5_000;

const json = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? Number(x) : x)));

export async function exportAccountData(prisma: PrismaClient, userId: string) {
  const where = { userId };
  const take = CAP + 1;
  const [
    profile,
    preferences,
    sessions,
    searches,
    watchlists,
    watchlistItems,
    alerts,
    alertEvaluations,
    notifications,
    pushSubscriptions,
    subscription,
    checkouts,
    usage,
    usageRecords,
    affiliateClicks,
    agentRuns,
    auditTrail,
  ] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
        lastLoginAt: true,
      },
    }),
    prisma.userPreference.findMany({ where }),
    prisma.userSession.findMany({
      where,
      take,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
    prisma.search.findMany({ where, take, orderBy: { createdAt: "desc" } }),
    prisma.watchlist.findMany({ where, take }),
    prisma.watchlistItem.findMany({ where, take }),
    prisma.priceAlert.findMany({ where, take }),
    prisma.alertEvaluation.findMany({ where, take, orderBy: { evaluatedAt: "desc" } }),
    prisma.notification.findMany({ where, take, orderBy: { createdAt: "desc" } }),
    prisma.pushSubscription.findMany({
      where,
      select: { id: true, endpoint: true, userAgent: true, createdAt: true, revokedAt: true },
    }),
    prisma.subscription.findUnique({ where }),
    prisma.checkoutSession.findMany({ where, take, orderBy: { createdAt: "desc" } }),
    prisma.usageCounter.findMany({ where, take }),
    prisma.usageRecord.findMany({ where, take }),
    prisma.affiliateClick.findMany({
      where,
      take,
      orderBy: { createdAt: "desc" },
      omit: { ipHash: true },
    }),
    prisma.agentRun.findMany({
      where,
      take,
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        searchId: true,
        graph: true,
        status: true,
        provider: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        startedAt: true,
        finishedAt: true,
      },
    }),
    // Security events about this account (sign-ins, password changes, ...).
    prisma.auditLog.findMany({
      where: { OR: [{ actorId: userId }, { entity: "User", entityId: userId }] },
      take,
      orderBy: { createdAt: "desc" },
      select: { action: true, entity: true, createdAt: true },
    }),
  ]);
  const capped: string[] = [];
  const cap = <T>(name: string, rows: T[]): T[] => {
    if (rows.length > CAP) capped.push(name);
    return rows.slice(0, CAP);
  };
  return json({
    format: "dealmind-account-export/1",
    generatedAt: new Date().toISOString(),
    notes: [
      "Passwords are held by the shared EasyDev identity service, not by DealMind.",
      "Payment records (amounts, methods, invoices) are held by the shared payment service.",
      "Security material (session token hashes, encrypted tokens, push keys, IP hashes) is not exported.",
    ],
    profile,
    preferences,
    sessions: cap("sessions", sessions),
    searches: cap("searches", searches),
    watchlists: cap("watchlists", watchlists),
    watchlistItems: cap("watchlistItems", watchlistItems),
    priceAlerts: cap("priceAlerts", alerts),
    alertEvaluations: cap("alertEvaluations", alertEvaluations),
    notifications: cap("notifications", notifications),
    pushSubscriptions,
    subscription,
    checkoutSessions: cap("checkoutSessions", checkouts),
    usageCounters: cap("usageCounters", usage),
    usageRecords: cap("usageRecords", usageRecords),
    affiliateClicks: cap("affiliateClicks", affiliateClicks),
    agentRuns: cap("agentRuns", agentRuns),
    accountEvents: cap("accountEvents", auditTrail),
    capped,
  });
}
