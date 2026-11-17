import { createECDH, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import webpush from "web-push";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryError,
  SharedServiceEmailProvider,
  WebPushProvider,
  buildNotification,
  createUnsubscribeToken,
  escapeHtml,
  quietUntil,
  renderEmail,
  renderPush,
  resolveChannels,
  verifyUnsubscribeToken,
} from "./index.js";

const U = "0190a000-0000-7000-8000-000000000001";
const A = "0190a000-0000-7000-8000-0000000000a1";
const C = "0190a000-0000-7000-8000-0000000000c1";
const P = "0190a000-0000-7000-8000-0000000000b1";
const V = "0190a000-0000-7000-8000-0000000000b2";
const O = "0190a000-0000-7000-8000-0000000000d1";
const NOW = new Date("2026-11-21T10:00:00.000Z"); // 15:30 IST

const triggered = (over: Record<string, unknown> = {}) =>
  buildNotification({
    kind: "alert.triggered",
    userId: U,
    alertId: A,
    checkId: C,
    type: "TARGET_PRICE_REACHED",
    title: "Acme Nova 7 is ₹29,500 on Mock Store Alpha",
    body: "Your target of ₹30,000 was reached.",
    product: { id: P, name: "Acme <Nova> 7", variantId: V, variantLabel: "8 GB · 128 GB" },
    marketplace: "Mock Store Alpha",
    pricePaise: 2_950_000,
    previousPricePaise: 3_100_000,
    targetPricePaise: 3_000_000,
    observedAt: NOW.toISOString(),
    offerId: O,
    alertType: "TARGET_PRICE",
    ...over,
  } as never);

const prefs = (over: Record<string, unknown> = {}) => ({
  notifyInApp: true,
  notifyEmail: true,
  notifyPush: true,
  notificationCategories: {},
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: "Asia/Kolkata",
  ...over,
});

describe("events → notifications", () => {
  it("names the verified source and a per-event dedupe key", () => {
    const n = triggered();
    expect(n).toMatchObject({
      userId: U,
      type: "TARGET_PRICE_REACHED",
      category: "PRICE_ALERTS",
      critical: false,
      sourceType: "ALERT_EVALUATION",
      sourceId: `${A}:${C}`,
      dedupeKey: `alert:${A}:check:${C}`,
      link: `/products/${P}?variant=${V}`,
    });
    expect(triggered().dedupeKey).toBe(n.dedupeKey);
  });

  it("rejects events without a valid source", () => {
    expect(() => triggered({ checkId: "not-a-uuid" })).toThrow();
    expect(() => buildNotification({ kind: "made.up", userId: U } as never)).toThrow();
  });

  it("marks security notices critical and search notices partial when they are", () => {
    const pw = buildNotification({
      kind: "account.password_changed",
      userId: U,
      auditId: A,
      at: NOW.toISOString(),
    });
    expect(pw).toMatchObject({ type: "PASSWORD_CHANGED", category: "ACCOUNT", critical: true });
    const s = buildNotification({
      kind: "search.finished",
      userId: U,
      searchId: A,
      status: "PARTIAL",
      query: "phone under 30k",
      resultCount: 4,
    });
    expect(s.type).toBe("SEARCH_COMPLETED");
    expect(s.body).toMatch(/partial/);
    expect(s.link).toBe(`/search/${A}`);
  });
});

describe("channel resolution", () => {
  const base = {
    category: "PRICE_ALERTS" as const,
    critical: false,
    hasEmail: true,
    activePushSubscriptions: 1,
    now: NOW,
  };

  it("uses a channel only when global, category and alert switches all allow it", () => {
    const all = resolveChannels({ ...base, prefs: prefs() });
    expect([all.inApp.use, all.email.use, all.push.use]).toEqual([true, true, true]);
    const noCat = resolveChannels({
      ...base,
      prefs: prefs({ notificationCategories: { PRICE_ALERTS: { email: false } } }),
    });
    expect(noCat.email).toEqual({ use: false, reason: "Email is off for this category" });
    const alertOnly = resolveChannels({ ...base, prefs: prefs(), alertChannels: ["IN_APP"] });
    expect([alertOnly.inApp.use, alertOnly.email.use, alertOnly.push.use]).toEqual([
      true,
      false,
      false,
    ]);
    const noSubs = resolveChannels({ ...base, prefs: prefs(), activePushSubscriptions: 0 });
    expect(noSubs.push).toEqual({ use: false, reason: "No browser is subscribed" });
  });

  it("defaults: push off until enabled, search emails off", () => {
    const d = resolveChannels({ ...base, prefs: null });
    expect([d.inApp.use, d.email.use, d.push.use]).toEqual([true, true, false]);
    const s = resolveChannels({ ...base, category: "SEARCH", prefs: null });
    expect(s.email.use).toBe(false);
  });

  it("never lets ordinary preferences suppress a security notice in-app, and never emails it", () => {
    const off = prefs({
      notifyInApp: false,
      notificationCategories: { ACCOUNT: { inApp: false, push: true } },
      quietHoursStart: "00:00",
      quietHoursEnd: "23:59",
    });
    const c = resolveChannels({ ...base, category: "ACCOUNT", critical: true, prefs: off });
    expect(c.inApp).toEqual({ use: true, notBefore: NOW });
    expect(c.email.use).toBe(false);
    // Critical push isn't delayed by quiet hours.
    expect(c.push).toEqual({ use: true, notBefore: NOW });
  });

  it("delays email and push (not in-app) during quiet hours, across midnight", () => {
    // 15:30 IST inside 15:00–16:00 → 16:00 IST = 10:30Z.
    const q = resolveChannels({
      ...base,
      prefs: prefs({ quietHoursStart: "15:00", quietHoursEnd: "16:00" }),
    });
    expect(q.inApp).toEqual({ use: true, notBefore: NOW });
    expect(q.email).toEqual({ use: true, notBefore: new Date("2026-11-21T10:30:00.000Z") });
    // 23:30 IST inside 22:00–07:00 → 07:00 IST next day.
    const late = new Date("2026-11-21T18:00:00.000Z");
    expect(quietUntil(late, { start: "22:00", end: "07:00" }, "Asia/Kolkata").toISOString()).toBe(
      "2026-11-22T01:30:00.000Z",
    );
    // Outside the window: now.
    expect(quietUntil(NOW, { start: "22:00", end: "07:00" }, "Asia/Kolkata")).toBe(NOW);
  });
});

describe("unsubscribe tokens", () => {
  const secret = "s".repeat(40);
  it("round-trips and rejects tampering, other secrets and expiry", () => {
    const t = createUnsubscribeToken(secret, U, "PRICE_ALERTS", NOW);
    expect(verifyUnsubscribeToken(secret, t, NOW)).toEqual({
      ok: true,
      userId: U,
      category: "PRICE_ALERTS",
    });
    const [body, sig] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), c: "SEARCH" }),
    ).toString("base64url");
    expect(verifyUnsubscribeToken(secret, `${forged}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verifyUnsubscribeToken("t".repeat(40), t, NOW).ok).toBe(false);
    expect(verifyUnsubscribeToken(secret, "garbage", NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    const later = new Date(NOW.getTime() + 366 * 86_400_000);
    expect(verifyUnsubscribeToken(secret, t, later)).toEqual({ ok: false, reason: "expired" });
  });
  it("refuses a short secret", () => {
    expect(() => createUnsubscribeToken("short", U, "SEARCH")).toThrow();
  });
});

describe("templates", () => {
  const stored = () => {
    const d = triggered();
    return { id: A, ...d, createdAt: NOW };
  };
  const ctx = {
    appUrl: "https://dealmind.example/",
    recipientName: "Asha <b>",
    unsubscribeUrl: "https://dealmind.example/unsubscribe?token=abc",
  };

  it("renders escaped HTML and text with INR prices, CTA, preferences and unsubscribe links", () => {
    const e = renderEmail(stored(), ctx);
    expect(e.subject).toBe("Acme Nova 7 is ₹29,500 on Mock Store Alpha");
    expect(e.html).toContain("Acme &lt;Nova&gt; 7 (8 GB · 128 GB)");
    expect(e.html).toContain("Hi Asha &lt;b&gt;,");
    expect(e.html).not.toContain("<Nova>");
    expect(e.html).toContain("₹29,500");
    expect(e.html).toContain("₹31,000");
    expect(e.html).toContain("₹30,000");
    expect(e.html).toContain(`href="https://dealmind.example/products/${P}?variant=${V}"`);
    expect(e.html).toContain('href="https://dealmind.example/settings/notifications"');
    expect(e.html).toContain('href="https://dealmind.example/unsubscribe?token=abc"');
    expect(e.html).toContain('name="viewport"');
    expect(e.text).toContain("Price now (incl. delivery): ₹29,500");
    expect(e.text).toContain(`View offers: https://dealmind.example/products/${P}?variant=${V}`);
    expect(e.text).toContain(
      "Unsubscribe from price alerts emails: https://dealmind.example/unsubscribe?token=abc",
    );
    expect(e.text).toMatch(/confirm it on the marketplace/);
  });

  it("never links outside the app", () => {
    const e = renderEmail({ ...stored(), link: "//evil.example/x" }, ctx);
    expect(e.html).not.toContain("evil.example");
    expect(renderPush({ ...stored(), link: "https://evil.example" }).url).toBe("/notifications");
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });

  it("keeps push payloads short", () => {
    const p = renderPush({ ...stored(), body: "x".repeat(1000) });
    expect(p.body).toHaveLength(240);
    expect(p).toMatchObject({ tag: A, url: `/products/${P}?variant=${V}` });
  });
});

describe("email provider (shared notification service)", () => {
  const msg = {
    to: "a@example.com",
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    idempotencyKey: "d-1",
    metadata: { product: "dealmind" },
  };

  it("sends pre-rendered html/text with the idempotency key", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, requestId: "r-1" }));
    const res = await new SharedServiceEmailProvider({ sendEmail }).send(msg);
    expect(res).toEqual({ messageId: "r-1" });
    expect(sendEmail).toHaveBeenCalledWith({
      to: "a@example.com",
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      idempotencyKey: "d-1",
      metadata: { product: "dealmind" },
    });
  });

  it("classifies failures: 4xx permanent, 429/5xx/timeouts transient", async () => {
    const fail = (err: unknown) =>
      new SharedServiceEmailProvider({
        sendEmail: async () => Promise.reject(err instanceof Error ? err : new Error(String(err))),
      }).send(msg);
    const http = (s: number) => Object.assign(new Error(`HTTP ${s}`), { statusCode: s });
    await expect(fail(http(400))).rejects.toMatchObject({ permanent: true });
    await expect(fail(http(429))).rejects.toMatchObject({ permanent: false });
    await expect(fail(http(503))).rejects.toMatchObject({ permanent: false });
    await expect(fail(new Error("timeout"))).rejects.toMatchObject({ permanent: false });
    await expect(
      fail(Object.assign(new Error("bad"), { name: "NotificationValidationError" })),
    ).rejects.toMatchObject({ permanent: true });
  });
});

describe("web push provider", () => {
  afterEach(() => vi.restoreAllMocks());
  const vapid = { ...webpush.generateVAPIDKeys(), subject: "mailto:ops@dealmind.example" };

  it("validates VAPID configuration", () => {
    expect(() => new WebPushProvider({ ...vapid, subject: "ops" })).toThrow(/VAPID_SUBJECT/);
    expect(() => new WebPushProvider({ ...vapid, privateKey: "x" })).toThrow(/PRIVATE/);
  });

  it("encrypts the payload for the subscription and signs with VAPID", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    };
    const payload = JSON.stringify({ title: "Secret price", body: "₹29,500" });
    const req = webpush.generateRequestDetails(sub, payload, {
      vapidDetails: vapid,
      contentEncoding: "aes128gcm",
    });
    expect(req.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(Buffer.from(req.body).toString("utf8")).not.toContain("Secret price");
    const ece = createRequire(import.meta.url)("http_ece") as {
      decrypt: (b: Buffer, p: Record<string, unknown>) => Buffer;
    };
    const plain = ece.decrypt(Buffer.from(req.body), {
      version: "aes128gcm",
      privateKey: ecdh,
      authSecret: auth,
    });
    expect(plain.toString("utf8")).toBe(payload);
  });

  it("marks 404/410 subscriptions gone, 429/5xx transient", async () => {
    const p = new WebPushProvider(vapid);
    const target = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "a", auth: "b" };
    const payload = { title: "t", body: "b", url: "/", tag: "x", type: "PRICE_DROP" as const };
    const fail = (status: number) =>
      vi
        .spyOn(webpush, "sendNotification")
        .mockRejectedValueOnce(Object.assign(new Error("push"), { statusCode: status }));
    fail(410);
    await expect(p.send(target, payload)).rejects.toMatchObject({ gone: true, permanent: true });
    fail(404);
    await expect(p.send(target, payload)).rejects.toMatchObject({ gone: true });
    fail(429);
    await expect(p.send(target, payload)).rejects.toMatchObject({ gone: false, permanent: false });
    fail(500);
    const err = await p.send(target, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect((err as DeliveryError).permanent).toBe(false);
  });
});
