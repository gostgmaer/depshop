/**
 * Entitlements and atomic usage enforcement (server-side, per user).
 *
 *  - checkEntitlement(userId, feature): is an on/off feature in the plan that
 *    applies now (effective plan: FREE after a lapse or grace period).
 *  - consumeUsage(db, userId, metric, quantity): metered counters (IST day /
 *    month). One conditional upsert, so concurrent requests can never push a
 *    counter past the limit. Call it inside the transaction that creates the
 *    thing being counted: a rollback releases the usage.
 *  - enforceGauge(db, userId, gauge, count): "at any time" limits (active
 *    alerts, watchlists, tracked products). Takes a per-user transaction
 *    advisory lock, then counts, so two concurrent creates can't both pass.
 *    Must run inside a transaction together with the insert.
 *  - getUsage(userId): the usage view.
 */
import type { Prisma, PrismaClient } from "@dealmind/db";
import {
  AppError,
  ErrorCode,
  type PlanCode,
  type PlanFeatures,
  type SubscriptionStatusValue,
  type UsageView,
} from "@dealmind/shared";
import { type Plan, type PlanRow, defaultPlan, planFromRow } from "../plans/catalog.js";
import { type Effective, effectivePlan } from "./policy.js";
import { type WindowKind, windowEnd, windowStart } from "../usage/windows.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const METERED = {
  searches: {
    metric: "SEARCH",
    limit: "searchesPerDay",
    window: "day",
    label: "AI searches today",
  },
  exports: {
    metric: "EXPORT",
    limit: "exportsPerMonth",
    window: "month",
    label: "Exports this month",
  },
} as const satisfies Record<
  string,
  { metric: "SEARCH" | "EXPORT"; limit: keyof Plan["limits"]; window: WindowKind; label: string }
>;
export type MeteredKey = keyof typeof METERED;

export const GAUGES = {
  activeAlerts: { limit: "activeAlerts", label: "active price alerts" },
  watchlists: { limit: "watchlists", label: "watchlists" },
  trackedProducts: { limit: "trackedProducts", label: "tracked products" },
} as const;
export type GaugeKey = keyof typeof GAUGES;

export interface PlanContext {
  /** The subscribed plan (may be paid but lapsed). */
  subscribed: Plan;
  /** The plan whose limits and features apply now. */
  plan: Plan;
  effective: Effective;
  subscription: {
    status: SubscriptionStatusValue;
    planCode: PlanCode;
  } | null;
}

export interface EntitlementOptions {
  graceDays?: number;
  now?: () => Date;
}

export class EntitlementService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: EntitlementOptions = {},
  ) {}

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  async plans(db: Db = this.prisma): Promise<Map<PlanCode, Plan>> {
    const rows = (await db.subscriptionPlan.findMany()) as PlanRow[];
    const map = new Map<PlanCode, Plan>();
    for (const r of rows) map.set(r.code, planFromRow(r));
    for (const c of ["FREE", "PRO", "BUSINESS"] as const)
      if (!map.has(c)) map.set(c, defaultPlan(c));
    return map;
  }

  async context(userId: string, db: Db = this.prisma): Promise<PlanContext> {
    const [sub, plans] = await Promise.all([
      db.subscription.findUnique({
        where: { userId },
        select: { planCode: true, status: true, currentPeriodEnd: true, pastDueSince: true },
      }),
      this.plans(db),
    ]);
    const effective = effectivePlan(sub, this.now(), this.opts.graceDays);
    return {
      subscribed: plans.get(sub?.planCode ?? "FREE")!,
      plan: plans.get(effective.plan)!,
      effective,
      subscription: sub ? { status: sub.status, planCode: sub.planCode } : null,
    };
  }

  async checkEntitlement(userId: string, feature: keyof PlanFeatures): Promise<boolean> {
    return (await this.context(userId)).plan.features[feature];
  }

  async requireFeature(userId: string, feature: keyof PlanFeatures, label: string): Promise<void> {
    if (!(await this.checkEntitlement(userId, feature)))
      throw new AppError(
        ErrorCode.PLAN_UPGRADE_REQUIRED,
        `${label} isn't included in your plan. Upgrade to use it.`,
        { feature },
      );
  }

  /** Atomically adds `quantity` to the current window's counter, or throws if that would exceed the limit. */
  async consumeUsage(db: Db, userId: string, key: MeteredKey, quantity = 1): Promise<number> {
    const m = METERED[key];
    const { plan } = await this.context(userId, db);
    const limit = plan.limits[m.limit];
    const start = windowStart(m.window, this.now());
    const rows = await db.$queryRaw<{ quantity: number }[]>`
      INSERT INTO "UsageCounter" ("userId", "metric", "periodStart", "quantity", "updatedAt")
      SELECT ${userId}::uuid, ${m.metric}::"UsageMetric", ${start}, ${quantity}, now()
      WHERE ${quantity}::int <= ${limit}::int
      ON CONFLICT ("userId", "metric", "periodStart") DO UPDATE
        SET "quantity" = "UsageCounter"."quantity" + EXCLUDED."quantity", "updatedAt" = now()
        WHERE "UsageCounter"."quantity" + EXCLUDED."quantity" <= ${limit}::int
      RETURNING "quantity"`;
    if (!rows.length)
      throw new AppError(
        ErrorCode.USAGE_LIMIT_EXCEEDED,
        limit === 0
          ? `${m.label.replace(/ (today|this month)$/, "")} aren't included in your plan. Upgrade to use them.`
          : `Your plan allows ${limit} ${m.label.toLowerCase()}. ${m.window === "day" ? "The limit resets at midnight IST" : "The limit resets on the 1st"}, or upgrade for more.`,
        { limit: m.limit, allowed: limit, resetsAt: windowEnd(m.window, this.now()).toISOString() },
      );
    return rows[0]!.quantity;
  }

  /**
   * "At any time" limit. Must be called inside a transaction (the advisory
   * lock is released at commit), before the insert it guards.
   */
  async enforceGauge(
    tx: Prisma.TransactionClient,
    userId: string,
    key: GaugeKey,
    count: () => Promise<number>,
    adding = 1,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`;
    const { plan } = await this.context(userId, tx);
    const limit = plan.limits[GAUGES[key].limit];
    const used = await count();
    if (used + adding > limit)
      throw new AppError(
        ErrorCode.USAGE_LIMIT_EXCEEDED,
        `Your plan allows ${limit} ${GAUGES[key].label}. Upgrade to add more.`,
        { limit: GAUGES[key].limit, allowed: limit },
      );
  }

  /** Current counts for this user's gauges (same definitions the enforcement uses). */
  gaugeCounts(db: Db, userId: string) {
    return {
      activeAlerts: () => db.priceAlert.count({ where: { userId, status: "ACTIVE" } }),
      watchlists: () => db.watchlist.count({ where: { userId } }),
      trackedProducts: () => db.watchlistItem.count({ where: { userId } }),
    };
  }

  async getUsage(userId: string): Promise<UsageView> {
    const now = this.now();
    const { plan } = await this.context(userId);
    const counts = this.gaugeCounts(this.prisma, userId);
    const counter = async (key: MeteredKey) => {
      const m = METERED[key];
      const row = await this.prisma.usageCounter.findUnique({
        where: {
          userId_metric_periodStart: {
            userId,
            metric: m.metric,
            periodStart: windowStart(m.window, now),
          },
        },
        select: { quantity: true },
      });
      return {
        key,
        label: m.label,
        used: row?.quantity ?? 0,
        limit: plan.limits[m.limit],
        resetsAt: windowEnd(m.window, now).toISOString(),
      };
    };
    const gauge = async (key: GaugeKey, label: string) => ({
      key,
      label,
      used: await counts[key](),
      limit: plan.limits[GAUGES[key].limit],
      resetsAt: null,
    });
    const items = await Promise.all([
      counter("searches"),
      gauge("activeAlerts", "Active price alerts"),
      gauge("watchlists", "Watchlists"),
      gauge("trackedProducts", "Tracked products"),
      counter("exports"),
    ]);
    return {
      plan: plan.code,
      items,
      historyDays: plan.limits.historyDays,
      compareItems: plan.limits.compareItems,
    };
  }
}
