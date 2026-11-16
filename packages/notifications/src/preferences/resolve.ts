/**
 * Which channels a notification uses, and when (pure).
 *
 *  - A channel is used only if the user's global switch, the category switch
 *    and (for alerts) the alert's own channels all allow it.
 *  - Critical (security) notices are always recorded in-app and never wait
 *    for quiet hours; ordinary preferences can't silently suppress them.
 *  - Account notices are never emailed by DealMind (the IAM emails them).
 *  - Quiet hours delay email and push (not in-app) until they end.
 */
import {
  type ChannelSet,
  type NotificationCategoryValue,
  type QuietHours,
  categoryChannelsOf,
} from "@dealmind/shared";

export interface StoredPreferences {
  notifyInApp: boolean;
  notifyEmail: boolean;
  notifyPush: boolean;
  notificationCategories: unknown;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
}

export const DEFAULT_PREFERENCES: StoredPreferences = {
  notifyInApp: true,
  notifyEmail: true,
  notifyPush: false,
  notificationCategories: {},
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: "Asia/Kolkata",
};

export type ChannelDecision = { use: true; notBefore: Date } | { use: false; reason: string };

export interface ChannelPlan {
  inApp: ChannelDecision;
  email: ChannelDecision;
  push: ChannelDecision;
}

export interface ResolveInput {
  category: NotificationCategoryValue;
  critical: boolean;
  prefs: StoredPreferences | null;
  /** The alert's own channels (alerts only). */
  alertChannels?: readonly ("IN_APP" | "EMAIL" | "PUSH")[];
  hasEmail: boolean;
  activePushSubscriptions: number;
  now: Date;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** Minutes past midnight of `now` in `timeZone`. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * When quiet hours are on and `now` is inside them, the moment they end;
 * otherwise `now`. Windows may wrap midnight (22:00–07:00).
 */
export function quietUntil(now: Date, quiet: QuietHours | null, timeZone: string): Date {
  if (!quiet) return now;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const t = localMinutes(now, timeZone);
  const inside = start < end ? t >= start && t < end : t >= start || t < end;
  if (!inside) return now;
  const wait = (end - t + 1440) % 1440;
  const at = new Date(now.getTime() + wait * 60_000);
  at.setUTCSeconds(0, 0);
  return at;
}

export function quietHoursOf(p: StoredPreferences | null): QuietHours | null {
  return p?.quietHoursStart && p.quietHoursEnd
    ? { start: p.quietHoursStart, end: p.quietHoursEnd }
    : null;
}

export function resolveChannels(input: ResolveInput): ChannelPlan {
  const prefs = input.prefs ?? DEFAULT_PREFERENCES;
  const categories: Record<NotificationCategoryValue, ChannelSet> = categoryChannelsOf(
    prefs.notificationCategories,
  );
  const cat = categories[input.category];
  const alert = input.alertChannels;
  const later = input.critical
    ? input.now
    : quietUntil(input.now, quietHoursOf(prefs), prefs.timezone || "Asia/Kolkata");
  const no = (reason: string): ChannelDecision => ({ use: false, reason });

  const inApp: ChannelDecision = input.critical
    ? { use: true, notBefore: input.now }
    : !prefs.notifyInApp
      ? no("In-app notifications are off")
      : !cat.inApp
        ? no("In-app notifications are off for this category")
        : alert && !alert.includes("IN_APP")
          ? no("This alert doesn't use in-app notifications")
          : { use: true, notBefore: input.now };

  const email: ChannelDecision =
    input.category === "ACCOUNT"
      ? no("Account emails are sent by the EasyDev account service")
      : !prefs.notifyEmail
        ? no("Email notifications are off")
        : !cat.email
          ? no("Email is off for this category")
          : alert && !alert.includes("EMAIL")
            ? no("This alert doesn't use email")
            : !input.hasEmail
              ? no("No email address on the account")
              : { use: true, notBefore: later };

  const push: ChannelDecision = !prefs.notifyPush
    ? no("Browser notifications are off")
    : !cat.push
      ? no("Browser notifications are off for this category")
      : alert && !alert.includes("PUSH")
        ? no("This alert doesn't use browser notifications")
        : input.activePushSubscriptions === 0
          ? no("No browser is subscribed")
          : { use: true, notBefore: later };

  return { inApp, email, push };
}
