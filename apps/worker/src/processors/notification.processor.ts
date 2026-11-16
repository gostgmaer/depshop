/**
 * Delivers one notification over one channel. Email goes through the shared
 * EasyDev notification service (DealMind sends no email itself); the
 * delivery id is the idempotency key, so a retried job never sends twice.
 * A delivery that isn't PENDING is never re-sent.
 */
import type { PrismaClient } from "@dealmind/db";
import { formatPaise } from "@dealmind/shared";
import type { TrackingMetrics } from "../services/tracking-metrics.js";

/** The subset of the notification SDK this worker uses. */
export interface EmailSender {
  sendEmail(payload: {
    to: string;
    subject?: string;
    template?: string;
    data?: Record<string, unknown>;
    idempotencyKey?: string;
    appUrl?: string;
    ctaPath?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; message?: string; data?: unknown }>;
}

export interface NotificationDeps {
  prisma: PrismaClient;
  metrics: TrackingMetrics;
  /** Null when no notification service is configured: email deliveries are SKIPPED. */
  email: EmailSender | null;
  appUrl: string;
  now?: () => Date;
}

export type DeliveryResult =
  | { action: "done"; status: "SENT" | "SKIPPED" | "NOT_PENDING" | "GONE" }
  | { action: "retry"; reason: string };

/** Notification type → shared-service template (variables it requires). */
function template(type: string, data: Record<string, unknown>, username: string, item: string) {
  const price = typeof data.pricePaise === "number" ? formatPaise(data.pricePaise) : "";
  if (type === "BACK_IN_STOCK")
    return { template: "wishlistBackInStockTemplate", data: { username, itemName: item } };
  if (type === "PRICE_CHANGED" && typeof data.previousPricePaise === "number")
    return {
      template: "cartItemPriceChangedTemplate",
      data: {
        username,
        itemName: item,
        oldPrice: formatPaise(data.previousPricePaise),
        newPrice: price,
      },
    };
  return {
    template: "wishlistPriceDropAlertTemplate",
    data: { username, itemName: item, newPrice: price },
  };
}

export async function processNotificationDelivery(
  deps: NotificationDeps,
  job: { deliveryId: string },
  ctx: { attempt: number; maxAttempts: number },
): Promise<DeliveryResult> {
  const now = (deps.now ?? (() => new Date()))();
  const d = await deps.prisma.notificationDelivery.findUnique({
    where: { id: job.deliveryId },
    include: {
      notification: true,
      user: { select: { email: true, name: true } },
    },
  });
  if (!d) return { action: "done", status: "GONE" };
  if (d.status !== "PENDING") return { action: "done", status: "NOT_PENDING" };

  const skip = async (reason: string) => {
    await deps.prisma.notificationDelivery.updateMany({
      where: { id: d.id, status: "PENDING" },
      data: { status: "SKIPPED", lastError: reason },
    });
    return { action: "done" as const, status: "SKIPPED" as const };
  };
  if (d.channel !== "EMAIL") return skip(`${d.channel} delivery is not available yet`);
  if (!deps.email) return skip("Notification service not configured");

  const data = (d.notification.data ?? {}) as Record<string, unknown>;
  const productId = typeof data.productId === "string" ? data.productId : null;
  const variantId = typeof data.variantId === "string" ? data.variantId : null;
  const t = template(d.notification.type, data, d.user.name, d.notification.title);
  try {
    const res = await deps.email.sendEmail({
      to: d.user.email,
      subject: d.notification.title,
      ...t,
      idempotencyKey: d.id,
      appUrl: deps.appUrl,
      ctaPath: productId
        ? `/products/${productId}${variantId ? `?variant=${variantId}` : ""}`
        : "/notifications",
      metadata: { product: "dealmind", notificationId: d.notification.id, channel: "EMAIL" },
    });
    if (!res.success) throw new Error(res.message ?? "Notification service rejected the email");
    await deps.prisma.notificationDelivery.updateMany({
      where: { id: d.id, status: "PENDING" },
      data: { status: "SENT", sentAt: now, attempts: { increment: 1 }, lastError: null },
    });
    await deps.metrics.inc({ deliveries_sent: 1 });
    return { action: "done", status: "SENT" };
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    const final = ctx.attempt >= ctx.maxAttempts;
    await deps.prisma.notificationDelivery.updateMany({
      where: { id: d.id, status: "PENDING" },
      data: {
        attempts: { increment: 1 },
        lastError: message,
        ...(final ? { status: "FAILED" } : {}),
      },
    });
    if (final) await deps.metrics.inc({ deliveries_failed: 1 });
    return { action: "retry", reason: message };
  }
}
