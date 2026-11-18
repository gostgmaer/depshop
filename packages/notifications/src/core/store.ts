/**
 * Records a notification and its per-channel deliveries inside the caller's
 * transaction (the transactional outbox): the source change, the notification
 * and its PENDING deliveries commit together. Nothing is sent here; the caller
 * enqueues the returned pending deliveries after commit, and the cleanup job
 * re-enqueues any PENDING delivery whose enqueue was lost.
 *
 * Duplicate events (same user + dedupe key) are ignored with
 * INSERT … ON CONFLICT DO NOTHING, which doesn't abort the transaction.
 */
import type { Prisma } from "@dealmind/db";
import { type ChannelPlan, resolveChannels } from "../preferences/resolve.js";
import type { NotificationDraft } from "./build.js";

export interface PendingDelivery {
  id: string;
  channel: "EMAIL" | "PUSH";
  notBefore: Date;
}

export type RecordResult =
  | { status: "created"; notificationId: string; inApp: boolean; pending: PendingDelivery[] }
  | { status: "duplicate" }
  /** No channel allowed: nothing recorded. */
  | { status: "suppressed"; reason: string };

export async function planChannels(
  tx: Prisma.TransactionClient,
  draft: NotificationDraft,
  opts: { alertChannels?: readonly ("IN_APP" | "EMAIL" | "PUSH")[]; now: Date },
): Promise<ChannelPlan> {
  const [user, pushCount] = await Promise.all([
    tx.user.findUnique({
      where: { id: draft.userId },
      select: {
        email: true,
        isGuest: true,
        preference: {
          select: {
            notifyInApp: true,
            notifyEmail: true,
            notifyPush: true,
            notificationCategories: true,
            quietHoursStart: true,
            quietHoursEnd: true,
            timezone: true,
          },
        },
      },
    }),
    tx.pushSubscription.count({
      where: { userId: draft.userId, revokedAt: null, expiredAt: null },
    }),
  ]);
  return resolveChannels({
    category: draft.category,
    critical: draft.critical,
    prefs: user?.preference ?? null,
    ...(opts.alertChannels ? { alertChannels: opts.alertChannels } : {}),
    // A guest (search without an account) has an undeliverable placeholder address and
    // can't subscribe to push: in-app only.
    hasEmail: Boolean(user?.email) && !user?.isGuest,
    activePushSubscriptions: user?.isGuest ? 0 : pushCount,
    now: opts.now,
  });
}

/** True when no channel would deliver the notification. */
export const noChannel = (p: ChannelPlan) => !p.inApp.use && !p.email.use && !p.push.use;

/** The reasons each unused channel gave, deduplicated. */
export const suppressionReason = (p: ChannelPlan) =>
  [...new Set([p.inApp, p.email, p.push].flatMap((c) => (c.use ? [] : [c.reason])))].join("; ");

export async function recordNotification(
  tx: Prisma.TransactionClient,
  draft: NotificationDraft,
  opts: {
    alertChannels?: readonly ("IN_APP" | "EMAIL" | "PUSH")[];
    now: Date;
    /** A plan already computed in this transaction (e.g. before a claim). */
    plan?: ChannelPlan;
  },
): Promise<RecordResult> {
  const plan = opts.plan ?? (await planChannels(tx, draft, opts));
  if (noChannel(plan)) return { status: "suppressed", reason: suppressionReason(plan) };

  const inserted = await tx.notification.createManyAndReturn({
    data: [
      {
        userId: draft.userId,
        type: draft.type,
        category: draft.category,
        critical: draft.critical,
        sourceType: draft.sourceType,
        sourceId: draft.sourceId,
        dedupeKey: draft.dedupeKey,
        title: draft.title,
        body: draft.body,
        link: draft.link,
        data: draft.data as Prisma.InputJsonValue,
        createdAt: opts.now,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  const notificationId = inserted[0]?.id;
  if (!notificationId) return { status: "duplicate" };

  const row = (channel: "IN_APP" | "EMAIL" | "PUSH", d: ChannelPlan["inApp"]) => ({
    userId: draft.userId,
    notificationId,
    channel,
    ...(d.use
      ? channel === "IN_APP"
        ? // The in-app record is the notification itself.
          { status: "SENT" as const, sentAt: opts.now, scheduledAt: opts.now }
        : { status: "PENDING" as const, scheduledAt: d.notBefore }
      : { status: "SKIPPED" as const, lastError: d.reason, scheduledAt: opts.now }),
  });
  const deliveries = await tx.notificationDelivery.createManyAndReturn({
    data: [row("IN_APP", plan.inApp), row("EMAIL", plan.email), row("PUSH", plan.push)],
    select: { id: true, channel: true, status: true, scheduledAt: true },
  });
  return {
    status: "created",
    notificationId,
    inApp: plan.inApp.use,
    pending: deliveries
      .filter((d) => d.status === "PENDING" && d.channel !== "IN_APP")
      .map((d) => ({
        id: d.id,
        channel: d.channel as "EMAIL" | "PUSH",
        notBefore: d.scheduledAt,
      })),
  };
}
