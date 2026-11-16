/**
 * Delivers one notification over one channel (EMAIL or PUSH). Channels are
 * independent: each has its own delivery row and job, so a failing email
 * never blocks push or the in-app record.
 *
 *  - Idempotent: the delivery id is the job id and the email idempotency key;
 *    a delivery that isn't PENDING is never re-sent; push remembers which
 *    subscriptions already received it (`sentTo`), so a retry sends only to
 *    the rest.
 *  - Consent at send time: a delayed (quiet-hours) delivery is re-checked
 *    against the user's current preferences before sending.
 *  - Permanent failures (bad address, rejected content, gone subscription)
 *    are not retried; transient ones retry with backoff, then dead-letter.
 *  - Payloads are never logged; stored errors are short and content-free.
 */
import type { PrismaClient } from "@dealmind/db";
import {
  DeliveryError,
  type EmailProvider,
  type PushProvider,
  type StoredNotification,
  createUnsubscribeToken,
  planChannels,
  renderEmail,
  renderPush,
  safeErrorText,
} from "@dealmind/notifications";
import type { TrackingMetrics } from "../services/tracking-metrics.js";

export interface NotificationDeps {
  prisma: PrismaClient;
  metrics: TrackingMetrics;
  /** Null when no email provider is configured: email deliveries are SKIPPED. */
  email: EmailProvider | null;
  /** Null when VAPID keys aren't configured: push deliveries are SKIPPED. */
  push: PushProvider | null;
  appUrl: string;
  /** Signs unsubscribe links; without it, emails link to the settings page. */
  tokenSecret: string | null;
  now?: () => Date;
}

export type DeliveryResult =
  | { action: "done"; status: "SENT" | "SKIPPED" | "FAILED" | "NOT_PENDING" | "GONE" }
  | { action: "delay"; ms: number; reason: string }
  | { action: "retry"; reason: string };

export async function processNotificationDelivery(
  deps: NotificationDeps,
  job: { deliveryId: string },
  ctx: { attempt: number; maxAttempts: number },
): Promise<DeliveryResult> {
  const { prisma } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const d = await prisma.notificationDelivery.findUnique({
    where: { id: job.deliveryId },
    include: { notification: true, user: { select: { email: true, name: true } } },
  });
  if (!d) return { action: "done", status: "GONE" };
  if (d.status !== "PENDING") return { action: "done", status: "NOT_PENDING" };
  // Not due yet (quiet hours): wait without spending an attempt.
  const wait = d.scheduledAt.getTime() - now.getTime();
  if (wait > 1_000) return { action: "delay", ms: wait, reason: "scheduled for later" };

  const finish = async (
    status: "SENT" | "SKIPPED" | "FAILED",
    extra: { lastError?: string | null; providerMessageId?: string | null; sentTo?: string[] } = {},
  ) => {
    await prisma.notificationDelivery.updateMany({
      where: { id: d.id, status: "PENDING" },
      data: {
        status,
        ...(status === "SENT" ? { sentAt: now, lastError: null } : {}),
        ...(status !== "SKIPPED" ? { attempts: { increment: 1 } } : {}),
        ...extra,
      },
    });
    if (status === "SENT")
      await deps.metrics.inc(
        d.channel === "EMAIL"
          ? { deliveries_sent: 1, deliveries_sent_email: 1 }
          : { deliveries_sent: 1, deliveries_sent_push: 1 },
      );
    if (status === "FAILED")
      await deps.metrics.inc(
        d.channel === "EMAIL"
          ? { deliveries_failed: 1, deliveries_failed_email: 1 }
          : { deliveries_failed: 1, deliveries_failed_push: 1 },
      );
    return { action: "done" as const, status };
  };
  const transient = async (reason: string, sentTo?: string[]) => {
    const final = ctx.attempt >= ctx.maxAttempts;
    if (final) {
      // Retries exhausted: record FAILED, and still fail the job so it is dead-lettered.
      await finish("FAILED", { lastError: reason, ...(sentTo ? { sentTo } : {}) });
      return { action: "retry" as const, reason };
    }
    await prisma.notificationDelivery.updateMany({
      where: { id: d.id, status: "PENDING" },
      data: { attempts: { increment: 1 }, lastError: reason, ...(sentTo ? { sentTo } : {}) },
    });
    return { action: "retry" as const, reason };
  };

  const n = d.notification;
  const stored: StoredNotification = {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    data: (n.data ?? {}) as Record<string, unknown>,
    createdAt: n.createdAt,
  };

  // Consent may have changed while the delivery waited.
  if (!n.critical) {
    const alertChannels =
      n.sourceType === "ALERT_EVALUATION" || n.sourceType === "ALERT_EXPIRY"
        ? await alertChannelsOf(prisma, stored.data.alertId)
        : undefined;
    const plan = await prisma.$transaction((tx) =>
      planChannels(
        tx,
        {
          userId: d.userId,
          type: stored.type,
          category: n.category,
          critical: n.critical,
          sourceType: n.sourceType,
          sourceId: n.sourceId,
          dedupeKey: n.dedupeKey,
          title: n.title,
          body: n.body,
          link: n.link,
          data: stored.data,
        },
        { ...(alertChannels ? { alertChannels } : {}), now },
      ),
    );
    const decision = d.channel === "EMAIL" ? plan.email : plan.push;
    if (!decision.use) return finish("SKIPPED", { lastError: `${decision.reason} (at send time)` });
  }

  if (d.channel === "EMAIL") {
    if (!deps.email) return finish("SKIPPED", { lastError: "Email provider not configured" });
    if (!d.user.email) return finish("SKIPPED", { lastError: "No email address on the account" });
    const unsubscribeUrl = deps.tokenSecret
      ? `${deps.appUrl.replace(/\/+$/, "")}/unsubscribe?token=${encodeURIComponent(
          createUnsubscribeToken(deps.tokenSecret, d.userId, n.category, now),
        )}`
      : `${deps.appUrl.replace(/\/+$/, "")}/settings/notifications`;
    const email = renderEmail(stored, {
      appUrl: deps.appUrl,
      recipientName: d.user.name || null,
      unsubscribeUrl,
    });
    try {
      const res = await deps.email.send({
        to: d.user.email,
        ...email,
        idempotencyKey: d.id,
        metadata: { product: "dealmind", notificationId: n.id, deliveryId: d.id, type: n.type },
      });
      return finish("SENT", { providerMessageId: res.messageId });
    } catch (err) {
      const reason = safeErrorText(err);
      if (err instanceof DeliveryError && err.permanent)
        return finish("FAILED", { lastError: reason });
      return transient(reason);
    }
  }

  if (d.channel === "PUSH") {
    if (!deps.push) return finish("SKIPPED", { lastError: "Web push not configured" });
    const already = new Set(d.sentTo);
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: d.userId, revokedAt: null, expiredAt: null },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
      orderBy: { createdAt: "asc" },
    });
    const todo = subs.filter((s) => !already.has(s.id));
    if (!todo.length)
      return already.size
        ? finish("SENT", { sentTo: [...already] })
        : finish("SKIPPED", { lastError: "No browser is subscribed" });
    const payload = renderPush(stored);
    const sentTo = [...already];
    let retryReason: string | null = null;
    let lastPermanent: string | null = null;
    for (const s of todo) {
      try {
        await deps.push.send(s, payload);
        sentTo.push(s.id);
        await prisma.pushSubscription.update({
          where: { id: s.id },
          data: { lastSuccessAt: now, failureCount: 0 },
        });
      } catch (err) {
        const reason = safeErrorText(err);
        if (err instanceof DeliveryError && err.gone) {
          await prisma.pushSubscription.update({
            where: { id: s.id },
            data: { expiredAt: now, failureCount: { increment: 1 } },
          });
          await deps.metrics.inc({ push_subscriptions_expired: 1 });
          lastPermanent = reason;
        } else {
          await prisma.pushSubscription.update({
            where: { id: s.id },
            data: { failureCount: { increment: 1 } },
          });
          if (err instanceof DeliveryError && err.permanent) lastPermanent = reason;
          else retryReason = reason;
        }
      }
    }
    if (retryReason) return transient(retryReason, sentTo);
    if (sentTo.length) return finish("SENT", { sentTo });
    return finish("FAILED", { lastError: lastPermanent ?? "No subscription accepted the push" });
  }

  return finish("SKIPPED", { lastError: `${d.channel} is delivered in-app` });
}

async function alertChannelsOf(
  prisma: PrismaClient,
  alertId: unknown,
): Promise<("IN_APP" | "EMAIL" | "PUSH")[] | undefined> {
  if (typeof alertId !== "string") return undefined;
  const a = await prisma.priceAlert.findUnique({
    where: { id: alertId },
    select: { channels: true },
  });
  return a?.channels;
}
