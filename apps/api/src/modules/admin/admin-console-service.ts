/**
 * Platform admin console data (ADMIN only; single platform, no tenancy).
 * Every number is read from stored data; nothing is estimated unless the
 * field says so. No secrets are read into responses: connector credentials
 * are reported by variable NAME (present/missing) via connector readiness,
 * and LLM keys stay in the agent's environment.
 */
import { affiliateSummary } from "@dealmind/affiliate";
import { type EntitlementService, effectivePlan, priceOf } from "@dealmind/billing";
import type { ConnectorRegistry, MetricsStore } from "@dealmind/connectors";
import type { Prisma, PrismaClient } from "@dealmind/db";
import { type JobQueues, QueueName } from "@dealmind/queue";
import type {
  AdminDashboardView,
  AdminJobsView,
  AdminSourceView,
  AdminUserDetail,
  SearchAnalyticsView,
  SubscriptionAnalyticsView,
} from "@dealmind/shared";

const DAY = 86_400_000;
export type Check = () => Promise<void>;

export interface AdminConsoleDeps {
  prisma: PrismaClient;
  jobs: JobQueues;
  entitlements: EntitlementService;
  /** Connector registry (credential readiness by name); null when not built. */
  registry: ConnectorRegistry | null;
  metrics: MetricsStore;
  /** System checks; `null` value = not configured. */
  checks: Record<string, Check | null>;
  now?: () => Date;
}

export const ADMIN_QUEUES = Object.values(QueueName).filter((q) => q !== QueueName.deadLetter);

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part * 10_000) / whole) : null;

export class AdminConsoleService {
  constructor(private readonly d: AdminConsoleDeps) {}

  private now() {
    return (this.d.now ?? (() => new Date()))();
  }

  async runChecks(): Promise<Record<string, "ok" | "fail" | "not_configured">> {
    const out: Record<string, "ok" | "fail" | "not_configured"> = {};
    await Promise.all(
      Object.entries(this.d.checks).map(async ([name, check]) => {
        if (!check) {
          out[name] = "not_configured";
          return;
        }
        try {
          await Promise.race([
            check(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
          ]);
          out[name] = "ok";
        } catch {
          out[name] = "fail";
        }
      }),
    );
    return out;
  }

  async queues() {
    return Promise.all(
      [...ADMIN_QUEUES, QueueName.deadLetter].map(async (name) => {
        const q = this.d.jobs.queue(name);
        const counts = await q.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
          "completed",
          "prioritized",
          "paused",
        );
        const workers = await q.getWorkers().catch(() => []);
        return { name, counts, workers: workers.length, paused: await q.isPaused() };
      }),
    );
  }

  /** Active paid subscriptions × list price (annual ÷ 12). An estimate, labelled as such. */
  private async estimatedMrr(): Promise<{ activePaid: number; mrrPaise: number }> {
    const now = this.now();
    const [subs, plans] = await Promise.all([
      this.d.prisma.subscription.findMany({
        where: { planCode: { not: "FREE" }, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
        select: {
          planCode: true,
          interval: true,
          status: true,
          currentPeriodEnd: true,
          pastDueSince: true,
        },
      }),
      this.d.entitlements.plans(),
    ]);
    let mrr = 0;
    let activePaid = 0;
    for (const s of subs) {
      if (effectivePlan(s, now).plan === "FREE") continue;
      activePaid += 1;
      const plan = plans.get(s.planCode);
      const price = plan ? priceOf(plan, s.interval ?? "MONTHLY") : null;
      if (price) mrr += s.interval === "ANNUAL" ? Math.floor(price / 12) : price;
    }
    return { activePaid, mrrPaise: mrr };
  }

  async dashboard(): Promise<AdminDashboardView> {
    const p = this.d.prisma;
    const now = this.now();
    const d30 = new Date(now.getTime() - 30 * DAY);
    const d7 = new Date(now.getTime() - 7 * DAY);
    const [
      users,
      active,
      new7,
      new30,
      suspended,
      sTotal,
      byStatus,
      s30,
      alerts,
      offers,
      mrr,
      refunds,
      aff,
      checks,
      queues,
      sources,
    ] = await Promise.all([
      // Accounts only: guests (search without an account) are not users here.
      p.user.count({ where: { isGuest: false } }),
      p.user.count({ where: { isGuest: false, lastLoginAt: { gte: d30 } } }),
      p.user.count({ where: { isGuest: false, createdAt: { gte: d7 } } }),
      p.user.count({ where: { isGuest: false, createdAt: { gte: d30 } } }),
      p.user.count({ where: { isGuest: false, status: "SUSPENDED" } }),
      p.search.count(),
      p.search.groupBy({ by: ["status"], _count: { _all: true } }),
      p.search.count({ where: { createdAt: { gte: d30 } } }),
      p.priceAlert.count({ where: { status: "ACTIVE" } }),
      p.productOffer.count({ where: { trackingState: "ACTIVE" } }),
      this.estimatedMrr(),
      p.billingEvent.count({ where: { eventType: "refund.updated", createdAt: { gte: d30 } } }),
      affiliateSummary(p, { from: new Date(0), to: now }),
      this.runChecks(),
      this.queues(),
      p.shoppingSource.findMany({
        orderBy: { name: "asc" },
        select: { slug: true, name: true, status: true, health: true },
      }),
    ]);
    const st = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    const dlq = queues.find((q) => q.name === QueueName.deadLetter);
    return {
      generatedAt: now.toISOString(),
      platform: {
        users,
        activeUsers30d: active,
        newUsers7d: new7,
        newUsers30d: new30,
        suspendedUsers: suspended,
        searches: {
          total: sTotal,
          completed: st("COMPLETED"),
          partial: st("PARTIAL"),
          failed: st("FAILED"),
          last30d: s30,
        },
        activeAlerts: alerts,
        trackedOffers: offers,
      },
      revenue: {
        subscriptions: {
          activePaid: mrr.activePaid,
          estimatedMrrPaise: mrr.mrrPaise,
          refundEvents30d: refunds,
          collectedRevenueNote:
            "Collected payments, taxes and refund amounts are kept by the shared EasyDev payment service (its ledger); DealMind shows estimates from list prices.",
        },
        affiliate: {
          confirmedCommissionPaise: aff.conversions.APPROVED.commissionPaise,
          confirmedConversions: aff.conversions.APPROVED.count,
          pendingCommissionPaise: aff.conversions.PENDING.commissionPaise,
          reversedCommissionPaise:
            aff.conversions.REVERSED.commissionPaise + aff.conversions.REJECTED.commissionPaise,
          paidOutPaise: aff.payouts.PAID.amountPaise,
        },
      },
      infrastructure: {
        checks,
        queues: queues
          .filter((q) => q.name !== QueueName.deadLetter)
          .map((q) => ({
            name: q.name,
            waiting: (q.counts.waiting ?? 0) + (q.counts.prioritized ?? 0),
            active: q.counts.active ?? 0,
            delayed: q.counts.delayed ?? 0,
            failed: q.counts.failed ?? 0,
            workers: q.workers,
          })),
        deadLetters: (dlq?.counts.waiting ?? 0) + (dlq?.counts.completed ?? 0),
        connectors: sources,
      },
    };
  }

  // ── Users ──

  async userDetail(id: string): Promise<AdminUserDetail | null> {
    const p = this.d.prisma;
    const u = await p.user.findUnique({
      where: { id },
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
    });
    if (!u) return null;
    const now = this.now();
    const d30 = new Date(now.getTime() - 30 * DAY);
    const [sessions, sub, ctx, searches, s30, alerts, lists, items, tokens] = await Promise.all([
      p.userSession.count({ where: { userId: id, revokedAt: null, expiresAt: { gt: now } } }),
      p.subscription.findUnique({ where: { userId: id } }),
      this.d.entitlements.context(id),
      p.search.count({ where: { userId: id } }),
      p.search.count({ where: { userId: id, createdAt: { gte: d30 } } }),
      p.priceAlert.count({ where: { userId: id, status: "ACTIVE" } }),
      p.watchlist.count({ where: { userId: id } }),
      p.watchlistItem.count({ where: { userId: id } }),
      p.agentRun.aggregate({
        where: { userId: id, startedAt: { gte: d30 } },
        _sum: { inputTokens: true, outputTokens: true },
      }),
    ]);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      emailVerified: u.emailVerifiedAt !== null,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      activeSessions: sessions,
      subscription: {
        plan: sub?.planCode ?? "FREE",
        effectivePlan: ctx.plan.code,
        status: sub?.status ?? "ACTIVE",
        currentPeriodEnd:
          sub?.planCode && sub.planCode !== "FREE"
            ? (sub.currentPeriodEnd?.toISOString() ?? null)
            : null,
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      },
      usage: {
        searchesTotal: searches,
        searches30d: s30,
        activeAlerts: alerts,
        watchlists: lists,
        trackedProducts: items,
        agentTokens30d: (tokens._sum.inputTokens ?? 0) + (tokens._sum.outputTokens ?? 0),
      },
    };
  }

  // ── Sources ──

  /** Readiness as the connector reports it; "configured" means READY and nothing else. */
  readiness(slug: string): {
    registered: boolean;
    state:
      "READY" | "PENDING_CREDENTIALS" | "PENDING_APPROVAL" | "NOT_SUPPORTED" | "NOT_REGISTERED";
    configured: boolean;
    missing: string[];
    reason: string | null;
  } {
    const c = this.d.registry?.get(slug);
    if (!c)
      return {
        registered: false,
        state: "NOT_REGISTERED",
        configured: false,
        missing: [],
        reason: null,
      };
    const r = c.getReadiness();
    return {
      registered: true,
      state: r.state,
      configured: r.state === "READY",
      missing: r.state === "PENDING_CREDENTIALS" ? r.missing : [],
      reason: r.state === "PENDING_APPROVAL" || r.state === "NOT_SUPPORTED" ? r.reason : null,
    };
  }

  async sources(): Promise<AdminSourceView[]> {
    const p = this.d.prisma;
    const since = new Date(this.now().getTime() - 30 * DAY);
    const [rows, runs] = await Promise.all([
      p.shoppingSource.findMany({ orderBy: { name: "asc" } }),
      p.searchSourceRun.groupBy({
        by: ["sourceId", "status"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { resultCount: true, durationMs: true },
      }),
    ]);
    return Promise.all(
      rows.map(async (s) => {
        const m = await this.d.metrics.read(s.id).catch(() => null);
        const mine = runs.filter((r) => r.sourceId === s.id);
        const total = mine.reduce((n, r) => n + r._count._all, 0);
        const ms = mine.reduce((n, r) => n + (r._sum.durationMs ?? 0), 0);
        const ready = this.readiness(s.slug);
        return {
          id: s.id,
          slug: s.slug,
          name: s.name,
          domain: s.domain,
          integrationKind: s.integrationKind,
          status: s.status,
          statusReason: s.statusReason,
          isSample: s.isSample,
          credentials: {
            state: ready.state,
            configured: ready.configured,
            missing: ready.missing,
            reason: ready.reason,
          },
          connectorRegistered: ready.registered,
          health: s.health,
          lastHealthCheckAt: s.lastHealthCheckAt?.toISOString() ?? null,
          lastHealthError: s.lastHealthError,
          lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
          settings: {
            timeoutMs: s.timeoutMs,
            rateLimitPerMinute: s.rateLimitPerMinute,
            maxRetries: s.maxRetries,
            cacheTtlSeconds: s.cacheTtlSeconds,
            trackingEnabled: s.trackingEnabled,
            affiliateEnabled: s.affiliateEnabled,
          },
          metrics: {
            requests: m?.requests ?? 0,
            failures: m?.failures ?? 0,
            timeouts: m?.timeouts ?? 0,
            rateLimitEvents: m?.rateLimitEvents ?? 0,
            results: m?.results ?? 0,
            averageLatencyMs: m?.averageLatencyMs ?? null,
            lastErrorCategory: m?.lastErrorCategory ?? null,
          },
          searchRuns30d: {
            total,
            failed: mine.find((r) => r.status === "FAILED")?._count._all ?? 0,
            timedOut: mine.find((r) => r.status === "TIMED_OUT")?._count._all ?? 0,
            averageMs: total ? Math.round(ms / total) : null,
            results: mine.reduce((n, r) => n + (r._sum.resultCount ?? 0), 0),
          },
        };
      }),
    );
  }

  // ── Analytics ──

  async searchAnalytics(days: number, minUsers = 3): Promise<SearchAnalyticsView> {
    const p = this.d.prisma;
    const since = new Date(this.now().getTime() - days * DAY);
    const [byStatus, duration, popular, empty, categories, connectors, agent, daily] =
      await Promise.all([
        p.search.groupBy({
          by: ["status"],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        p.$queryRaw<{ avg: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("completedAt" - "createdAt")) * 1000)::float AS avg
        FROM "Search" WHERE "createdAt" >= ${since} AND "completedAt" IS NOT NULL`,
        // Privacy: only queries searched by at least `minUsers` different users; no user ids.
        p.$queryRaw<{ query: string; searches: bigint; users: bigint }[]>`
        SELECT lower(btrim("query")) AS query, COUNT(*)::bigint AS searches, COUNT(DISTINCT "userId")::bigint AS users
        FROM "Search" WHERE "createdAt" >= ${since}
        GROUP BY 1 HAVING COUNT(DISTINCT "userId") >= ${minUsers}
        ORDER BY 2 DESC LIMIT 20`,
        p.$queryRaw<{ query: string; searches: bigint; users: bigint }[]>`
        SELECT lower(btrim(s."query")) AS query, COUNT(*)::bigint AS searches, COUNT(DISTINCT s."userId")::bigint AS users
        FROM "Search" s
        WHERE s."createdAt" >= ${since} AND s."status" IN ('COMPLETED', 'PARTIAL')
          AND NOT EXISTS (SELECT 1 FROM "SearchResult" r WHERE r."searchId" = s."id")
        GROUP BY 1 HAVING COUNT(DISTINCT s."userId") >= ${minUsers}
        ORDER BY 2 DESC LIMIT 20`,
        p.$queryRaw<{ category: string; searches: bigint }[]>`
        SELECT COALESCE(c."name", NULLIF(s."intent"->>'categorySlug', ''), NULLIF(s."intent"->>'category_slug', ''), NULLIF(s."filters"->>'category', ''), 'Unspecified') AS category,
               COUNT(*)::bigint AS searches
        FROM "Search" s
        LEFT JOIN "Category" c ON c."slug" = COALESCE(s."intent"->>'categorySlug', s."intent"->>'category_slug', s."filters"->>'category')
        WHERE s."createdAt" >= ${since}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
        p.$queryRaw<
          { slug: string; runs: bigint; failed: bigint; timed_out: bigint; avg_ms: number | null }[]
        >`
        SELECT src."slug", COUNT(*)::bigint AS runs,
               COUNT(*) FILTER (WHERE r."status" = 'FAILED')::bigint AS failed,
               COUNT(*) FILTER (WHERE r."status" = 'TIMED_OUT')::bigint AS timed_out,
               AVG(r."durationMs")::float AS avg_ms
        FROM "SearchSourceRun" r JOIN "ShoppingSource" src ON src."id" = r."sourceId"
        WHERE r."createdAt" >= ${since}
        GROUP BY src."slug" ORDER BY 2 DESC`,
        p.agentRun.groupBy({
          by: ["status"],
          where: { startedAt: { gte: since } },
          _count: { _all: true },
        }),
        p.$queryRaw<{ day: string; searches: bigint; failed: bigint }[]>`
        SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
               COUNT(*)::bigint AS searches, COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS failed
        FROM "Search" WHERE "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
      ]);
    const total = byStatus.reduce((n, s) => n + s._count._all, 0);
    const st = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    const finished = st("COMPLETED") + st("PARTIAL") + st("FAILED");
    const ag = (s: string) => agent.find((a) => a.status === s)?._count._all ?? 0;
    return {
      days,
      total,
      byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count._all])),
      successRateBp: pct(st("COMPLETED") + st("PARTIAL"), finished),
      partialRateBp: pct(st("PARTIAL"), finished),
      averageDurationMs: duration[0]?.avg != null ? Math.round(duration[0].avg) : null,
      popularQueries: popular.map((q) => ({
        query: q.query.slice(0, 120),
        searches: Number(q.searches),
        users: Number(q.users),
      })),
      emptyResultQueries: empty.map((q) => ({
        query: q.query.slice(0, 120),
        searches: Number(q.searches),
        users: Number(q.users),
      })),
      minUsers,
      categories: categories.map((c) => ({ category: c.category, searches: Number(c.searches) })),
      connectors: connectors.map((c) => ({
        slug: c.slug,
        runs: Number(c.runs),
        failed: Number(c.failed),
        timedOut: Number(c.timed_out),
        averageMs: c.avg_ms != null ? Math.round(c.avg_ms) : null,
      })),
      agentRuns: {
        total: agent.reduce((n, a) => n + a._count._all, 0),
        failed: ag("FAILED"),
        cancelled: ag("CANCELLED"),
      },
      daily: daily.map((d) => ({
        day: d.day,
        searches: Number(d.searches),
        failed: Number(d.failed),
      })),
    };
  }

  async subscriptionAnalytics(): Promise<SubscriptionAnalyticsView> {
    const p = this.d.prisma;
    const now = this.now();
    const d30 = new Date(now.getTime() - 30 * DAY);
    const [users, subs, mrr, audits, webhooks] = await Promise.all([
      p.user.count({ where: { isGuest: false } }),
      p.subscription.findMany({
        select: {
          planCode: true,
          status: true,
          currentPeriodEnd: true,
          pastDueSince: true,
          cancelledAt: true,
          updatedAt: true,
        },
      }),
      this.estimatedMrr(),
      p.auditLog.findMany({
        where: {
          action: "billing.subscription_synced",
          createdAt: { gte: new Date(now.getTime() - 365 * DAY) },
        },
        select: { createdAt: true, metadata: true },
      }),
      p.billingEvent.groupBy({
        by: ["eventType"],
        where: { createdAt: { gte: d30 } },
        _count: { _all: true },
      }),
    ]);
    const plans: Record<string, number> = { FREE: 0, PRO: 0, BUSINESS: 0 };
    for (const s of subs) {
      const eff = effectivePlan(s, now).plan;
      plans[eff] = (plans[eff] ?? 0) + 1;
    }
    // Users without a subscription row are on FREE.
    plans.FREE = (plans.FREE ?? 0) + Math.max(0, users - subs.length);
    const byStatus: Record<string, number> = {};
    for (const s of subs.filter((x) => x.planCode !== "FREE"))
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const monthly = new Map<
      string,
      { activations: number; cancellations: number; paymentFailures: number }
    >();
    let failures30 = 0;
    for (const a of audits) {
      const changes = ((a.metadata as { changes?: unknown }).changes ?? []) as string[];
      const m = a.createdAt.toISOString().slice(0, 7);
      const row = monthly.get(m) ?? { activations: 0, cancellations: 0, paymentFailures: 0 };
      if (changes.includes("activated")) row.activations += 1;
      if (changes.includes("ended") || changes.includes("cancel_scheduled")) row.cancellations += 1;
      if (changes.includes("payment_failed")) {
        row.paymentFailures += 1;
        if (a.createdAt >= d30) failures30 += 1;
      }
      monthly.set(m, row);
    }
    return {
      plans: Object.entries(plans).map(([plan, n]) => ({ plan, users: n })),
      byStatus,
      activePaid: mrr.activePaid,
      pastDue: byStatus.PAST_DUE ?? 0,
      cancelledOrEnded30d: subs.filter(
        (s) =>
          s.planCode !== "FREE" &&
          ["CANCELLED", "EXPIRED"].includes(s.status) &&
          s.updatedAt >= d30,
      ).length,
      paymentFailures30d: failures30,
      estimatedMrrPaise: mrr.mrrPaise,
      monthly: [...monthly.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({ month, ...v })),
      webhookEvents: Object.fromEntries(
        webhooks.map((w) => [w.eventType || "unknown", w._count._all]),
      ),
      note: "Plan counts use the plan in effect now (grace periods applied). MRR is an estimate from list prices; collected amounts are in the payment service's ledger.",
    };
  }

  // ── Jobs ──

  async jobs(): Promise<AdminJobsView> {
    const queues = await this.queues();
    const failed = (
      await Promise.all(
        ADMIN_QUEUES.map(async (name) => {
          const jobs = await this.d.jobs.queue(name).getFailed(0, 9);
          return jobs.filter(Boolean).map((j) => ({
            queue: name,
            id: String(j.id),
            name: j.name,
            attemptsMade: j.attemptsMade,
            // Error text only (no job payloads: they can contain user data).
            failedReason: (j.failedReason ?? "").slice(0, 300),
            failedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
          }));
        }),
      )
    ).flat();
    const dead = await this.d.jobs
      .queue(QueueName.deadLetter)
      .getJobs(["waiting", "completed", "delayed"], 0, 19);
    return {
      queues,
      failed,
      deadLetters: dead.filter(Boolean).map((j) => {
        const data = (j.data ?? {}) as {
          queue?: string;
          jobId?: string;
          failedReason?: string;
          attemptsMade?: number;
          failedAt?: string;
        };
        return {
          id: String(j.id),
          queue: String(data.queue ?? ""),
          jobId: String(data.jobId ?? ""),
          failedReason: String(data.failedReason ?? "").slice(0, 300),
          attemptsMade: Number(data.attemptsMade ?? 0),
          failedAt: String(data.failedAt ?? ""),
        };
      }),
    };
  }

  /** Retries one failed job (no bulk operations). */
  async retryJob(queue: string, id: string): Promise<"retried" | "not-found" | "not-failed"> {
    if (!(ADMIN_QUEUES as string[]).includes(queue)) return "not-found";
    const job = await this.d.jobs.queue(queue as QueueName).getJob(id);
    if (!job) return "not-found";
    if (!(await job.isFailed())) return "not-failed";
    await job.retry("failed");
    return "retried";
  }

  /** Product search with offer counts (provenance kept on offers; read-only here). */
  productWhere(q: string | undefined, active: boolean | undefined): Prisma.ProductWhereInput {
    return {
      ...(active === undefined ? {} : { isActive: active }),
      ...(q
        ? /^[0-9a-f-]{36}$/i.test(q)
          ? { id: q }
          : {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { brand: { contains: q, mode: "insensitive" } },
              ],
            }
        : {}),
    };
  }
}
