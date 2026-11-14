/**
 * Plans, subscriptions and usage limits. Subscriptions belong to individual
 * users; limits come from the (admin-editable) SubscriptionPlan rows, falling
 * back to the default catalogue if a row is missing or malformed.
 */
import type { PrismaClient } from "@dealmind/db";
import {
  AppError,
  DEFAULT_PLANS,
  ErrorCode,
  PlanCode,
  type PlanView,
  paiseFromDb,
} from "@dealmind/shared";
import { z } from "zod";
import { iso } from "../../utils/http.js";

const limitsSchema = z.object({
  searchesPerDay: z.number().int().nonnegative(),
  activeAlerts: z.number().int().nonnegative(),
  watchlists: z.number().int().nonnegative(),
});

export type LimitName = keyof z.infer<typeof limitsSchema>;

const DAY_MS = 86_400_000;

export class PlanService {
  constructor(private readonly prisma: PrismaClient) {}

  private toPlanView(row: {
    code: PlanCode;
    name: string;
    monthlyPricePaise: bigint;
    limits: unknown;
  }): PlanView {
    const parsed = limitsSchema.safeParse(row.limits);
    return {
      code: row.code,
      name: row.name,
      monthlyPricePaise: paiseFromDb(row.monthlyPricePaise),
      limits: parsed.success ? parsed.data : DEFAULT_PLANS[row.code].limits,
    };
  }

  async listPlans(): Promise<PlanView[]> {
    const rows = await this.prisma.subscriptionPlan.findMany({
      where: { active: true },
      orderBy: { monthlyPricePaise: "asc" },
    });
    return rows.map((r) => this.toPlanView(r));
  }

  /** The caller's subscription; users without one are on FREE. */
  async getSubscription(userId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });
    if (!sub) {
      const free = DEFAULT_PLANS.FREE;
      return {
        plan: free,
        status: "ACTIVE" as const,
        currentPeriodStart: new Date(0).toISOString(),
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      };
    }
    return {
      plan: this.toPlanView(sub.plan),
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart.toISOString(),
      currentPeriodEnd: iso(sub.currentPeriodEnd),
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    };
  }

  private async limits(userId: string): Promise<{ plan: PlanCode; limits: PlanView["limits"] }> {
    const sub = await this.getSubscription(userId);
    // A non-active (e.g. past-due) paid plan falls back to FREE limits.
    const plan = sub.status === "ACTIVE" ? sub.plan : DEFAULT_PLANS.FREE;
    return { plan: PlanCode.parse(plan.code), limits: plan.limits };
  }

  private searchesToday(userId: string) {
    return this.prisma.usageRecord.aggregate({
      where: { userId, metric: "SEARCH", occurredAt: { gte: new Date(Date.now() - DAY_MS) } },
      _sum: { quantity: true },
    });
  }

  async usage(userId: string) {
    const { plan, limits } = await this.limits(userId);
    const [searches, activeAlerts, watchlists, oldest] = await Promise.all([
      this.searchesToday(userId),
      this.prisma.priceAlert.count({ where: { userId, status: "ACTIVE" } }),
      this.prisma.watchlist.count({ where: { userId } }),
      this.prisma.usageRecord.findFirst({
        where: { userId, metric: "SEARCH", occurredAt: { gte: new Date(Date.now() - DAY_MS) } },
        orderBy: { occurredAt: "asc" },
        select: { occurredAt: true },
      }),
    ]);
    return {
      plan,
      searchesToday: {
        used: searches._sum.quantity ?? 0,
        limit: limits.searchesPerDay,
        // Rolling 24 h window: the oldest counted search frees up first.
        resetsAt: new Date((oldest?.occurredAt.getTime() ?? Date.now()) + DAY_MS).toISOString(),
      },
      activeAlerts: { used: activeAlerts, limit: limits.activeAlerts },
      watchlists: { used: watchlists, limit: limits.watchlists },
    };
  }

  /** Throws USAGE_LIMIT_EXCEEDED (429) if creating one more would exceed the plan. */
  async assertWithinLimit(userId: string, limit: LimitName): Promise<void> {
    const { limits } = await this.limits(userId);
    const used =
      limit === "searchesPerDay"
        ? ((await this.searchesToday(userId))._sum.quantity ?? 0)
        : limit === "activeAlerts"
          ? await this.prisma.priceAlert.count({ where: { userId, status: "ACTIVE" } })
          : await this.prisma.watchlist.count({ where: { userId } });
    if (used >= limits[limit]) {
      const label = {
        searchesPerDay: "daily searches",
        activeAlerts: "active alerts",
        watchlists: "watchlists",
      }[limit];
      throw new AppError(
        ErrorCode.USAGE_LIMIT_EXCEEDED,
        `Your plan allows ${limits[limit]} ${label}. Upgrade to add more.`,
        {
          limit,
          allowed: limits[limit],
        },
      );
    }
  }
}
