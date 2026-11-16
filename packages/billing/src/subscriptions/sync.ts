/**
 * The only writer of a user's local Subscription mirror for paid plans.
 *
 * It reads the customer's subscriptions from the payment provider
 * (server-to-server, authoritative) and applies the current one in a
 * transaction that locks the user's row, so concurrent webhooks, checkout
 * confirmations and reconcile runs serialize. Webhook payloads and browser
 * callbacks are only triggers: nothing here trusts them.
 *
 * Transitions produce user notifications (outbox, same transaction) and an
 * audit entry: activated, renewed, payment failed (grace period), cancel
 * scheduled, ended. Pending checkouts the provider now confirms are
 * completed.
 */
import type { Prisma, PrismaClient } from "@dealmind/db";
import {
  type PendingDelivery,
  buildNotification,
  publishSignal,
  recordNotification,
} from "@dealmind/notifications";
import type { BillingIntervalValue, PlanCode, SubscriptionStatusValue } from "@dealmind/shared";
import { effectivePlan } from "../entitlements/policy.js";
import type { EntitlementService } from "../entitlements/service.js";
import type { Plan } from "../plans/catalog.js";
import type { BillingProvider, CustomerRef, ProviderSubscription } from "../providers/interface.js";

export type SyncSource =
  | { kind: "webhook"; billingEventId: string }
  | { kind: "checkout"; checkoutId: string }
  | { kind: "user"; action: string }
  | { kind: "reconcile" };

export interface SyncDeps {
  prisma: PrismaClient;
  provider: BillingProvider;
  entitlements: EntitlementService;
  /** Enqueue email/push deliveries after commit (optional). */
  enqueueDelivery?: (id: string, notBefore?: Date) => Promise<void>;
  realtime?: { redis: { publish(c: string, m: string): Promise<unknown> }; prefix: string };
  graceDays?: number;
  now?: () => Date;
}

export type SyncResult =
  | { status: "no-customer" }
  | { status: "no-subscription" }
  | {
      status: "synced";
      subscriptionId: string;
      changes: Change[];
      planCode: PlanCode;
      providerStatus: SubscriptionStatusValue;
    };

type Change =
  "activated" | "renewed" | "payment_failed" | "cancel_scheduled" | "ended" | "plan_changed";

const LIVE: readonly SubscriptionStatusValue[] = ["ACTIVE", "TRIALING", "PAST_DUE", "PAUSED"];
const PAID_OK: readonly SubscriptionStatusValue[] = ["ACTIVE", "TRIALING"];

export async function customerOf(
  prisma: PrismaClient | Prisma.TransactionClient,
  userId: string,
): Promise<CustomerRef | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { iamUserId: true, email: true },
  });
  return u?.iamUserId ? { customerId: u.iamUserId, email: u.email } : null;
}

/** Provider plan id → DealMind plan + interval. */
export function planIndex(plans: Map<PlanCode, Plan>) {
  const index = new Map<string, { plan: Plan; interval: BillingIntervalValue }>();
  for (const plan of plans.values())
    for (const [interval, id] of Object.entries(plan.providerPlanIds) as [
      BillingIntervalValue,
      string,
    ][])
      index.set(id, { plan, interval });
  return index;
}

/** The subscription that matters: a live one, else the newest ended one. */
export function pickCurrent(subs: ProviderSubscription[]): ProviderSubscription | null {
  return subs.find((s) => LIVE.includes(s.status)) ?? subs[0] ?? null;
}

export class SubscriptionSync {
  constructor(private readonly deps: SyncDeps) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  async syncUser(userId: string, source: SyncSource): Promise<SyncResult> {
    const { prisma, provider } = this.deps;
    const customer = await customerOf(prisma, userId);
    if (!customer) return { status: "no-customer" };
    const [providerSubs, plans] = await Promise.all([
      provider.listSubscriptions(customer),
      this.deps.entitlements.plans(),
    ]);
    const index = planIndex(plans);
    const mine = providerSubs.filter((s) => index.has(s.planId));
    const current = pickCurrent(mine);
    if (!current) return { status: "no-subscription" };
    const mapped = index.get(current.planId)!;
    const now = this.now();

    const pending: { userId: string; deliveries: PendingDelivery[]; notificationId: string }[] = [];
    const result = await prisma.$transaction(async (tx) => {
      // Serialize every writer of this user's subscription.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:subscription`}, 0))`;
      const prev = await tx.subscription.findUnique({ where: { userId } });

      const samePeriodSub = prev?.providerSubscriptionId === current.id;
      const pastDueSince =
        current.status === "PAST_DUE"
          ? samePeriodSub && prev?.status === "PAST_DUE" && prev.pastDueSince
            ? prev.pastDueSince
            : now
          : null;
      const data = {
        planCode: mapped.plan.code,
        status: current.status,
        interval: mapped.interval,
        currentPeriodStart: current.currentPeriodStart,
        currentPeriodEnd: current.currentPeriodEnd,
        cancelAtPeriodEnd: current.cancelAtPeriodEnd,
        trialEnd: current.trialEnd,
        cancelledAt: current.cancelledAt,
        pastDueSince,
        provider: provider.name,
        providerSubscriptionId: current.id,
        lastSyncedAt: now,
      };
      const sub = prev
        ? await tx.subscription.update({ where: { userId }, data })
        : await tx.subscription.create({ data: { userId, ...data } });

      // ── What changed (for notifications and audit) ──
      const changes: Change[] = [];
      const wasPaidOk = !!prev && prev.planCode !== "FREE" && PAID_OK.includes(prev.status);
      const isPaidOk = PAID_OK.includes(current.status);
      if (isPaidOk && (!wasPaidOk || !samePeriodSub)) changes.push("activated");
      else if (
        isPaidOk &&
        samePeriodSub &&
        prev?.currentPeriodEnd &&
        current.currentPeriodEnd.getTime() > prev.currentPeriodEnd.getTime()
      )
        changes.push("renewed");
      if (isPaidOk && samePeriodSub && prev && prev.planCode !== mapped.plan.code)
        changes.push("plan_changed");
      if (current.status === "PAST_DUE" && !(samePeriodSub && prev?.status === "PAST_DUE"))
        changes.push("payment_failed");
      if (
        current.cancelAtPeriodEnd &&
        LIVE.includes(current.status) &&
        !(samePeriodSub && prev?.cancelAtPeriodEnd)
      )
        changes.push("cancel_scheduled");
      if (
        (current.status === "CANCELLED" || current.status === "EXPIRED") &&
        !(samePeriodSub && (prev?.status === "CANCELLED" || prev?.status === "EXPIRED"))
      )
        changes.push("ended");

      if (changes.length || !prev)
        await tx.auditLog.create({
          data: {
            actorId: source.kind === "user" ? userId : null,
            action: "billing.subscription_synced",
            entity: "Subscription",
            entityId: sub.id,
            metadata: {
              source: source.kind,
              ...(source.kind === "webhook" ? { billingEventId: source.billingEventId } : {}),
              ...(source.kind === "checkout" ? { checkoutId: source.checkoutId } : {}),
              ...(source.kind === "user" ? { action: source.action } : {}),
              from: prev ? { plan: prev.planCode, status: prev.status } : null,
              to: { plan: mapped.plan.code, status: current.status },
              changes,
            },
          },
        });

      // ── Notifications (verified source: the provider state at this period) ──
      const effective = effectivePlan(sub, now, this.deps.graceDays);
      for (const c of changes) {
        if (c === "plan_changed") continue; // covered by the page and audit log
        const draft = buildNotification({
          kind: "billing.subscription",
          userId,
          change: c,
          subscriptionId: sub.id,
          sourceKey: `${current.id}:${c === "renewed" || c === "activated" || c === "payment_failed" ? current.currentPeriodEnd.toISOString() : c}`,
          planName: mapped.plan.name,
          periodEnd: current.currentPeriodEnd.toISOString(),
          graceUntil: effective.graceUntil?.toISOString() ?? null,
        });
        const r = await recordNotification(tx, draft, { now });
        if (r.status === "created")
          pending.push({ userId, deliveries: r.pending, notificationId: r.notificationId });
      }

      // ── Pending checkouts the provider has now confirmed ──
      if (isPaidOk)
        await tx.checkoutSession.updateMany({
          where: {
            userId,
            status: { in: ["PENDING", "VERIFYING"] },
            planCode: mapped.plan.code,
            interval: mapped.interval,
            provider: provider.name,
          },
          data: { status: "SUCCEEDED", completedAt: now, failureReason: null },
        });

      return { subscriptionId: sub.id, changes };
    });

    for (const p of pending) {
      if (this.deps.enqueueDelivery)
        for (const d of p.deliveries)
          await this.deps.enqueueDelivery(d.id, d.notBefore).catch(() => undefined);
      if (this.deps.realtime)
        await publishSignal(this.deps.realtime.redis, this.deps.realtime.prefix, p.userId, {
          type: "created",
          id: p.notificationId,
        });
    }
    return {
      status: "synced",
      subscriptionId: result.subscriptionId,
      changes: result.changes,
      planCode: mapped.plan.code,
      providerStatus: current.status,
    };
  }
}
