/**
 * Notification contracts (Phase 5.3): types, categories, per-user
 * preferences, the in-app view and web-push subscription bodies.
 *
 * Every notification belongs to one user and has a verified event source
 * (an alert evaluation, a search, or a confirmed account action).
 */
import { z } from "zod";

export const NOTIFICATION_TYPES = [
  "PRICE_DROP",
  "TARGET_PRICE_REACHED",
  "BACK_IN_STOCK",
  "PRICE_CHANGED",
  "ALERT_EXPIRED",
  "SEARCH_COMPLETED",
  "SEARCH_FAILED",
  "PASSWORD_CHANGED",
  "NEW_SIGN_IN",
  "SUBSCRIPTION_ACTIVATED",
  "SUBSCRIPTION_RENEWED",
  "PAYMENT_FAILED",
  "SUBSCRIPTION_CANCELLED",
  "SUBSCRIPTION_ENDED",
  "REFUND_UPDATED",
  "SYSTEM",
] as const;
export type NotificationTypeValue = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CATEGORIES = ["PRICE_ALERTS", "SEARCH", "ACCOUNT", "BILLING"] as const;
export type NotificationCategoryValue = (typeof NOTIFICATION_CATEGORIES)[number];

export const CATEGORY_OF: Record<NotificationTypeValue, NotificationCategoryValue> = {
  PRICE_DROP: "PRICE_ALERTS",
  TARGET_PRICE_REACHED: "PRICE_ALERTS",
  BACK_IN_STOCK: "PRICE_ALERTS",
  PRICE_CHANGED: "PRICE_ALERTS",
  ALERT_EXPIRED: "PRICE_ALERTS",
  SEARCH_COMPLETED: "SEARCH",
  SEARCH_FAILED: "SEARCH",
  PASSWORD_CHANGED: "ACCOUNT",
  NEW_SIGN_IN: "ACCOUNT",
  SUBSCRIPTION_ACTIVATED: "BILLING",
  SUBSCRIPTION_RENEWED: "BILLING",
  PAYMENT_FAILED: "BILLING",
  SUBSCRIPTION_CANCELLED: "BILLING",
  SUBSCRIPTION_ENDED: "BILLING",
  REFUND_UPDATED: "BILLING",
  SYSTEM: "ACCOUNT",
};

/**
 * Security notices: always recorded in-app (not suppressible by category or
 * global in-app settings) and never delayed by quiet hours.
 */
export const CRITICAL_TYPES: readonly NotificationTypeValue[] = ["PASSWORD_CHANGED", "NEW_SIGN_IN"];
export const isCritical = (t: NotificationTypeValue) => CRITICAL_TYPES.includes(t);

export const NOTIFICATION_CHANNEL_KEYS = ["inApp", "email", "push"] as const;
export type NotificationChannelKey = (typeof NOTIFICATION_CHANNEL_KEYS)[number];

const channelSet = z.object({ inApp: z.boolean(), email: z.boolean(), push: z.boolean() }).strict();
export type ChannelSet = z.infer<typeof channelSet>;

export const DEFAULT_CATEGORY_CHANNELS: Record<NotificationCategoryValue, ChannelSet> = {
  PRICE_ALERTS: { inApp: true, email: true, push: true },
  SEARCH: { inApp: true, email: false, push: false },
  // Account emails are sent by the EasyDev account service (IAM), not DealMind.
  ACCOUNT: { inApp: true, email: false, push: true },
  // Transactional: always shown in the app.
  BILLING: { inApp: true, email: true, push: false },
};

/** "HH:MM", 24-hour. */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

export const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const timeZone = z.string().min(1).max(64).refine(isValidTimeZone, "Unknown time zone");

export const quietHours = z
  .object({ start: clock, end: clock })
  .strict()
  .refine((q) => q.start !== q.end, "Start and end must differ");
export type QuietHours = z.infer<typeof quietHours>;

/** Languages with notification templates. */
export const NOTIFICATION_LANGUAGES = ["en-IN"] as const;

export const notificationPreferences = z.object({
  inAppEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  categories: z.object({
    PRICE_ALERTS: channelSet,
    SEARCH: channelSet,
    ACCOUNT: channelSet,
    BILLING: channelSet,
  }),
  quietHours: quietHours.nullable(),
  timezone: timeZone,
  language: z.enum(NOTIFICATION_LANGUAGES),
  /** Active browser push subscriptions of this user. */
  pushSubscriptions: z.number().int().nonnegative(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferences>;

export const updateNotificationPreferencesInput = z
  .object({
    inAppEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    pushEnabled: z.boolean(),
    categories: z
      .object({
        PRICE_ALERTS: channelSet.partial().strict(),
        SEARCH: channelSet.partial().strict(),
        ACCOUNT: channelSet.partial().strict(),
        BILLING: channelSet.partial().strict(),
      })
      .partial()
      .strict(),
    quietHours: quietHours.nullable(),
    timezone: timeZone,
    language: z.enum(NOTIFICATION_LANGUAGES),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesInput>;

/** Stored category JSON → full, validated channel sets (unknown/missing keys fall back to defaults). */
export function categoryChannelsOf(raw: unknown): Record<NotificationCategoryValue, ChannelSet> {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as Record<NotificationCategoryValue, ChannelSet>;
  for (const c of NOTIFICATION_CATEGORIES) {
    const v = (src[c] && typeof src[c] === "object" ? src[c] : {}) as Record<string, unknown>;
    const d = DEFAULT_CATEGORY_CHANNELS[c];
    out[c] = {
      inApp: typeof v.inApp === "boolean" ? v.inApp : d.inApp,
      email: typeof v.email === "boolean" ? v.email : d.email,
      push: typeof v.push === "boolean" ? v.push : d.push,
    };
  }
  // Account notices are always in-app; DealMind never emails them.
  out.ACCOUNT = { ...out.ACCOUNT, inApp: true, email: false };
  // Billing notices are transactional: always in-app.
  out.BILLING = { ...out.BILLING, inApp: true };
  return out;
}

// ── In-app list ───────────────────────────────────────────────────────────

export const notificationView = z.object({
  id: z.string().uuid(),
  type: z.enum(NOTIFICATION_TYPES),
  category: z.enum(NOTIFICATION_CATEGORIES),
  critical: z.boolean(),
  title: z.string(),
  body: z.string(),
  /** In-app link for the notification (relative path), if any. */
  link: z.string().nullable(),
  data: z.record(z.unknown()),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type NotificationView = z.infer<typeof notificationView>;

export const notificationListQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    unread: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  })
  .strict();

// ── Web push ──────────────────────────────────────────────────────────────

const base64url = z.string().regex(/^[A-Za-z0-9_-]+=*$/, "Expected base64url");

export const pushSubscribeInput = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine((u) => u.startsWith("https://"), "Push endpoints must use HTTPS"),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: base64url.max(200), auth: base64url.max(100) }).strict(),
  })
  .strict();
export type PushSubscribeInput = z.infer<typeof pushSubscribeInput>;

export const pushUnsubscribeInput = z.object({ endpoint: z.string().url().max(2048) }).strict();

export const pushConfigView = z.object({
  /** VAPID public key (base64url), or null when web push isn't configured. */
  publicKey: z.string().nullable(),
});

/** Body of the one-click unsubscribe page (signed token from an email). */
export const unsubscribeInput = z.object({ token: z.string().min(10).max(1000) }).strict();
export const unsubscribeView = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  channel: z.literal("email"),
});
