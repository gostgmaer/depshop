/**
 * Email (HTML + plain text) and web-push renderings of a stored notification.
 * Every dynamic value is HTML-escaped; prices come from integer paise; links
 * are built from the app URL and the notification's relative in-app path.
 */
import {
  CATEGORY_OF,
  type NotificationCategoryValue,
  type NotificationTypeValue,
  formatPaise,
} from "@dealmind/shared";

export interface StoredNotification {
  id: string;
  type: NotificationTypeValue;
  title: string;
  body: string;
  link: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface EmailContext {
  appUrl: string;
  recipientName: string | null;
  /** One-click unsubscribe URL for this category's emails. */
  unsubscribeUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const BRAND = { name: "DealMind AI", color: "#0f766e", ink: "#0f172a", muted: "#475569" };

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** Absolute URL for a relative in-app path (never an external link). */
export function appLink(appUrl: string, path: string | null): string {
  const base = appUrl.replace(/\/+$/, "");
  if (!path || !path.startsWith("/") || path.startsWith("//")) return `${base}/notifications`;
  return `${base}${path}`;
}

const CTA: Partial<Record<NotificationTypeValue, string>> = {
  PRICE_DROP: "View offers",
  TARGET_PRICE_REACHED: "View offers",
  BACK_IN_STOCK: "View offers",
  PRICE_CHANGED: "View price history",
  ALERT_EXPIRED: "Create a new alert",
  SEARCH_COMPLETED: "See results",
  SEARCH_FAILED: "Open search",
};

const CATEGORY_LABEL: Record<NotificationCategoryValue, string> = {
  PRICE_ALERTS: "price alerts",
  SEARCH: "search updates",
  ACCOUNT: "account notices",
};

/** Price facts shown in the email, from the notification's stored data only. */
function facts(n: StoredNotification): [string, string][] {
  const d = n.data;
  const rows: [string, string][] = [];
  const product = str(d.productName);
  const variant = str(d.variantLabel);
  if (product) rows.push(["Product", product + (variant ? ` (${variant})` : "")]);
  const marketplace = str(d.marketplace);
  if (marketplace) rows.push(["Marketplace", marketplace]);
  const price = num(d.pricePaise);
  if (price !== null) rows.push(["Price now (incl. delivery)", formatPaise(price)]);
  const prev = num(d.previousPricePaise);
  if (prev !== null) rows.push(["Previous price", formatPaise(prev)]);
  const target = num(d.targetPricePaise);
  if (target !== null) rows.push(["Your target", formatPaise(target)]);
  const observed = str(d.observedAt);
  if (observed && !Number.isNaN(Date.parse(observed)))
    rows.push([
      "Observed",
      new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
      }).format(new Date(observed)) + " IST",
    ]);
  return rows;
}

export function renderEmail(n: StoredNotification, ctx: EmailContext): RenderedEmail {
  const category = CATEGORY_OF[n.type];
  const url = appLink(ctx.appUrl, n.link);
  const prefsUrl = appLink(ctx.appUrl, "/settings/notifications");
  const cta = CTA[n.type] ?? "Open DealMind";
  const greeting = ctx.recipientName ? `Hi ${ctx.recipientName},` : "Hi,";
  const rows = facts(n);
  const isPrice = category === "PRICE_ALERTS" && num(n.data.pricePaise) !== null;
  const disclaimer = isPrice
    ? "Prices change often. This was the delivered price when we last checked; confirm it on the marketplace before buying."
    : null;
  const why = `You're receiving this because ${CATEGORY_LABEL[category]} by email are on in your DealMind settings.`;

  const e = escapeHtml;
  const factRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:${BRAND.muted};font-size:14px;width:45%">${e(k)}</td>` +
        `<td style="padding:6px 0;color:${BRAND.ink};font-size:14px;font-weight:600">${e(v)}</td></tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(n.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">${e(n.body.slice(0, 140))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${BRAND.color};padding:16px 24px;color:#ffffff;font-size:18px;font-weight:700">${e(BRAND.name)}</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 12px;color:${BRAND.ink};font-size:15px">${e(greeting)}</p>
<h1 style="margin:0 0 12px;color:${BRAND.ink};font-size:20px;line-height:1.3">${e(n.title)}</h1>
<p style="margin:0 0 16px;color:${BRAND.ink};font-size:15px;line-height:1.5">${e(n.body)}</p>
${factRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">${factRows}</table>` : ""}
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${BRAND.color}">
<a href="${e(url)}" style="display:inline-block;padding:12px 20px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${e(cta)}</a>
</td></tr></table>
${disclaimer ? `<p style="margin:16px 0 0;color:${BRAND.muted};font-size:12px;line-height:1.5">${e(disclaimer)}</p>` : ""}
</td></tr>
<tr><td style="padding:16px 24px;background:#f8fafc;color:${BRAND.muted};font-size:12px;line-height:1.5">
${e(why)}<br>
<a href="${e(prefsUrl)}" style="color:${BRAND.muted}">Notification settings</a> · <a href="${e(ctx.unsubscribeUrl)}" style="color:${BRAND.muted}">Unsubscribe from ${e(CATEGORY_LABEL[category])} emails</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    greeting,
    "",
    n.title,
    "",
    n.body,
    ...(rows.length ? ["", ...rows.map(([k, v]) => `${k}: ${v}`)] : []),
    "",
    `${cta}: ${url}`,
    ...(disclaimer ? ["", disclaimer] : []),
    "",
    "—",
    why,
    `Notification settings: ${prefsUrl}`,
    `Unsubscribe from ${CATEGORY_LABEL[category]} emails: ${ctx.unsubscribeUrl}`,
    "",
    BRAND.name,
  ].join("\n");

  return { subject: n.title.slice(0, 200), html, text };
}

/** Web-push payload: short, no private details beyond the title and body. */
export interface PushPayload {
  title: string;
  body: string;
  /** Relative in-app path opened on click. */
  url: string;
  tag: string;
  type: NotificationTypeValue;
}

export function renderPush(n: StoredNotification): PushPayload {
  return {
    title: n.title.slice(0, 120),
    body: n.body.slice(0, 240),
    url: n.link && n.link.startsWith("/") && !n.link.startsWith("//") ? n.link : "/notifications",
    tag: n.id,
    type: n.type,
  };
}
