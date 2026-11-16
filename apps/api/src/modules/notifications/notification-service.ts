/**
 * The caller's notifications, notification preferences and browser push
 * subscriptions, plus the account events the API itself observes.
 *
 * Ownership: every query is scoped by the authenticated userId; another
 * user's notification or subscription is "not found" (no existence leak).
 * The in-app list shows notifications whose in-app delivery was SENT.
 */
import type { Prisma } from "@dealmind/db";
import { type PrismaClient } from "@dealmind/db";
import {
  type NotificationDraft,
  type PendingDelivery,
  type RealtimeSignal,
  buildNotification,
  publishSignal,
  recordNotification,
  verifyUnsubscribeToken,
} from "@dealmind/notifications";
import { type JobQueues, NOTIFICATION_DELIVERY_JOB_OPTIONS, QueueName } from "@dealmind/queue";
import {
  AppError,
  ErrorCode,
  type NotificationCategoryValue,
  type NotificationPreferences,
  type NotificationView,
  type PushSubscribeInput,
  type UpdateNotificationPreferencesInput,
  categoryChannelsOf,
  paginationOf,
} from "@dealmind/shared";
import type { Redis } from "ioredis";

export interface NotificationServiceDeps {
  prisma: PrismaClient;
  redis: Redis | null;
  redisPrefix: string;
  jobs: JobQueues | null;
  /** Verifies unsubscribe tokens; null disables one-click unsubscribe. */
  tokenSecret: string | null;
  log?: { warn(o: object, m: string): void };
  now?: () => Date;
}

type Row = Prisma.NotificationGetPayload<object>;

export const toView = (n: Row): NotificationView => ({
  id: n.id,
  type: n.type,
  category: n.category,
  critical: n.critical,
  title: n.title,
  body: n.body,
  link: n.link,
  data: (n.data ?? {}) as Record<string, unknown>,
  readAt: n.readAt?.toISOString() ?? null,
  createdAt: n.createdAt.toISOString(),
});

/** Notifications visible in-app: the in-app delivery was sent. */
const visible = (userId: string) => ({
  userId,
  deliveries: { some: { channel: "IN_APP" as const, status: "SENT" as const } },
});

const DAY = 86_400_000;

export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }
  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private signal(userId: string, s: RealtimeSignal) {
    return publishSignal(this.deps.redis, this.deps.redisPrefix, userId, s);
  }

  // ── In-app list ──────────────────────────────────────────────────────────

  async list(
    userId: string,
    q: { page: number; pageSize: number; unread?: boolean; category?: NotificationCategoryValue },
  ) {
    const where = {
      ...visible(userId),
      ...(q.unread === true ? { readAt: null } : {}),
      ...(q.category ? { category: q.category } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { items: rows.map(toView), pagination: paginationOf(q, total) };
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { ...visible(userId), readAt: null } });
  }

  async markRead(userId: string, id: string): Promise<NotificationView> {
    const existing = await this.prisma.notification.findFirst({
      where: { id, ...visible(userId) },
    });
    if (!existing) throw AppError.notFound("Notification");
    if (existing.readAt) return toView(existing);
    const updated = await this.prisma.notification.update({
      where: { id: existing.id },
      data: { readAt: this.now() },
    });
    await this.signal(userId, { type: "read", id });
    return toView(updated);
  }

  async readAll(userId: string, category?: NotificationCategoryValue) {
    const res = await this.prisma.notification.updateMany({
      where: { ...visible(userId), readAt: null, ...(category ? { category } : {}) },
      data: { readAt: this.now() },
    });
    if (res.count) await this.signal(userId, { type: "read-all" });
    return { updated: res.count };
  }

  /** Deletes the notification and its delivery records (cascade). */
  async remove(userId: string, id: string): Promise<void> {
    const res = await this.prisma.notification.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw AppError.notFound("Notification");
    await this.signal(userId, { type: "deleted", id });
  }

  // ── Preferences ──────────────────────────────────────────────────────────

  async preferences(userId: string): Promise<NotificationPreferences> {
    const [p, subs] = await Promise.all([
      this.prisma.userPreference.findUnique({ where: { userId } }),
      this.prisma.pushSubscription.count({ where: { userId, revokedAt: null, expiredAt: null } }),
    ]);
    return {
      inAppEnabled: p?.notifyInApp ?? true,
      emailEnabled: p?.notifyEmail ?? true,
      pushEnabled: p?.notifyPush ?? false,
      categories: categoryChannelsOf(p?.notificationCategories ?? {}),
      quietHours:
        p?.quietHoursStart && p.quietHoursEnd
          ? { start: p.quietHoursStart, end: p.quietHoursEnd }
          : null,
      timezone: p?.timezone ?? "Asia/Kolkata",
      language: "en-IN",
      pushSubscriptions: subs,
    };
  }

  async updatePreferences(
    userId: string,
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferences> {
    const current = await this.preferences(userId);
    const categories = { ...current.categories };
    for (const [c, v] of Object.entries(input.categories ?? {}))
      categories[c as NotificationCategoryValue] = {
        ...categories[c as NotificationCategoryValue],
        ...v,
      };
    const data = {
      ...(input.inAppEnabled !== undefined ? { notifyInApp: input.inAppEnabled } : {}),
      ...(input.emailEnabled !== undefined ? { notifyEmail: input.emailEnabled } : {}),
      ...(input.pushEnabled !== undefined ? { notifyPush: input.pushEnabled } : {}),
      // Normalized (account notices stay in-app, never emailed by DealMind).
      notificationCategories: categoryChannelsOf(categories) as Prisma.InputJsonObject,
      ...(input.quietHours !== undefined
        ? {
            quietHoursStart: input.quietHours?.start ?? null,
            quietHoursEnd: input.quietHours?.end ?? null,
          }
        : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.language !== undefined ? { locale: input.language } : {}),
    };
    await this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.preferences(userId);
  }

  /** One-click email unsubscribe from a signed token (no session needed). */
  async unsubscribe(token: string) {
    if (!this.deps.tokenSecret)
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Unsubscribe links are not enabled");
    const v = verifyUnsubscribeToken(this.deps.tokenSecret, token, this.now());
    if (!v.ok)
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        v.reason === "expired"
          ? "This unsubscribe link has expired. Change your settings in DealMind instead."
          : "This unsubscribe link isn't valid.",
      );
    const user = await this.prisma.user.findUnique({
      where: { id: v.userId },
      select: { id: true },
    });
    if (!user) throw new AppError(ErrorCode.BAD_REQUEST, "This unsubscribe link isn't valid.");
    await this.updatePreferences(v.userId, { categories: { [v.category]: { email: false } } });
    return { category: v.category, channel: "email" as const };
  }

  // ── Browser push subscriptions ──────────────────────────────────────────

  /**
   * Stores (or refreshes) this browser's subscription for the caller. An
   * endpoint belongs to one browser profile; if another account used it
   * before, it moves to the caller (that browser is now signed in as them).
   */
  async subscribePush(userId: string, input: PushSubscribeInput, userAgent?: string) {
    const data = {
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      expirationTime:
        typeof input.expirationTime === "number" ? new Date(input.expirationTime) : null,
      userAgent: userAgent?.slice(0, 300) ?? null,
      revokedAt: null,
      expiredAt: null,
      failureCount: 0,
    };
    const active = await this.prisma.pushSubscription.count({
      where: { userId, revokedAt: null, expiredAt: null, endpoint: { not: input.endpoint } },
    });
    if (active >= 10)
      throw new AppError(
        ErrorCode.CONFLICT,
        "Too many browsers subscribed. Turn notifications off on one you no longer use.",
      );
    const sub = await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: { endpoint: input.endpoint, ...data },
      update: data,
      select: { id: true, createdAt: true },
    });
    return { id: sub.id, createdAt: sub.createdAt.toISOString() };
  }

  /** Revokes the caller's subscription for this endpoint (another user's: not found). */
  async unsubscribePush(userId: string, endpoint: string) {
    const res = await this.prisma.pushSubscription.updateMany({
      where: { userId, endpoint, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    if (res.count === 0) throw AppError.notFound("Push subscription");
  }

  // ── Account events observed by the API ──────────────────────────────────

  /** Records an event's notification (outbox), then enqueues and signals after commit. */
  async emit(draft: NotificationDraft): Promise<void> {
    const now = this.now();
    const r = await this.prisma.$transaction((tx) => recordNotification(tx, draft, { now }));
    if (r.status !== "created") return;
    await this.enqueue(r.pending);
    await this.signal(draft.userId, { type: "created", id: r.notificationId });
  }

  private async enqueue(pending: PendingDelivery[]) {
    if (!this.deps.jobs) return; // the worker's cleanup re-enqueues PENDING deliveries
    for (const d of pending) {
      const delay = Math.max(0, d.notBefore.getTime() - Date.now());
      try {
        await this.deps.jobs.enqueue(
          QueueName.notificationDelivery,
          { deliveryId: d.id },
          { ...NOTIFICATION_DELIVERY_JOB_OPTIONS, ...(delay ? { delay } : {}) },
        );
      } catch (err) {
        this.deps.log?.warn(
          { deliveryId: d.id, err: (err as Error).message },
          "delivery enqueue failed; cleanup will retry",
        );
      }
    }
  }

  /** After a confirmed password change (the audit entry is the source). */
  async passwordChanged(userId: string, auditId: string) {
    await this.emit(
      buildNotification({
        kind: "account.password_changed",
        userId,
        auditId,
        at: this.now().toISOString(),
      }),
    );
  }

  /**
   * After a successful sign-in: notifies when this device (user agent) hasn't
   * signed in to the account in the last 90 days. A brand-new account's first
   * sign-in doesn't notify.
   */
  async signedIn(userId: string, sessionId: string, userAgent: string | undefined) {
    const now = this.now();
    const earlier = await this.prisma.userSession.findMany({
      where: {
        userId,
        id: { not: sessionId },
        createdAt: { gte: new Date(now.getTime() - 90 * DAY) },
      },
      select: { userAgent: true },
      take: 200,
    });
    const ever = earlier.length
      ? true
      : (await this.prisma.userSession.count({ where: { userId, id: { not: sessionId } } })) > 0;
    if (!ever) return;
    const ua = userAgent ?? "";
    if (earlier.some((s) => (s.userAgent ?? "") === ua)) return;
    await this.emit(
      buildNotification({
        kind: "account.new_sign_in",
        userId,
        sessionId,
        at: now.toISOString(),
        device: describeDevice(ua),
      }),
    );
  }
}

/** "Chrome on Windows" from a user agent (coarse; never the raw string). */
export function describeDevice(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "an unrecognized device";
}
