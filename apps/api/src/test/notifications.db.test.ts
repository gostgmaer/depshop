/**
 * Phase 5.3 API: in-app notifications (visibility, read, read-all, delete,
 * pagination, categories), cross-user isolation, preferences, one-click
 * unsubscribe, browser push subscriptions, account events with verified
 * sources, and the live SSE stream.
 */
import type { AddressInfo } from "node:net";
import {
  type NotificationEvent,
  buildNotification,
  createUnsubscribeToken,
  generateVapidKeys,
  publishSignal,
  recordNotification,
} from "@dealmind/notifications";
import { QueueName } from "@dealmind/queue";
import { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  Agent,
  PASSWORD,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  testRedisUrl,
  truncateAll,
} from "./harness.js";

const SECRET = "n".repeat(40);
const VAPID = generateVapidKeys();
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp({
    NOTIFICATION_TOKEN_SECRET: SECRET,
    VAPID_PUBLIC_KEY: VAPID.publicKey,
  });
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
});

const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
type View = {
  id: string;
  type: string;
  category: string;
  critical: boolean;
  readAt: string | null;
  link: string | null;
};

let seq = 0;
/** Records a notification the way the worker does (verified source + outbox). */
async function notify(userId: string, kind: "search" | "expired" = "search", now = new Date()) {
  seq += 1;
  const id = `0190a000-0000-7000-8000-${String(seq).padStart(12, "0")}`;
  const event: NotificationEvent =
    kind === "search"
      ? {
          kind: "search.finished",
          userId,
          searchId: id,
          status: "COMPLETED",
          query: `query ${seq}`,
          resultCount: 3,
        }
      : {
          kind: "alert.expired",
          userId,
          alertId: id,
          product: { id, name: "Acme Nova 7", variantId: id },
          expiresAt: now.toISOString(),
        };
  const r = await ctx.prisma.$transaction((tx) =>
    recordNotification(tx, buildNotification(event), { now }),
  );
  if (r.status !== "created") throw new Error(r.status);
  return r.notificationId;
}

describe("in-app notifications", () => {
  it("lists only the caller's visible notifications, newest first, with category filter and pages", async () => {
    const { agent, userId } = await signUp(ctx, "list@example.com");
    const other = await signUp(ctx, "other@example.com");
    const t = Date.now();
    const a = await notify(userId, "search", new Date(t - 3_000));
    const b = await notify(userId, "expired", new Date(t - 2_000));
    const c = await notify(userId, "search", new Date(t - 1_000));
    await notify(other.userId);
    // In-app turned off for searches: the next one isn't shown in-app (and has no channel at all).
    await ctx.prisma.userPreference.upsert({
      where: { userId },
      create: { userId, notificationCategories: { SEARCH: { inApp: false } } },
      update: { notificationCategories: { SEARCH: { inApp: false } } },
    });
    await expect(notify(userId)).rejects.toThrow("suppressed");

    const all = await agent.get("/api/v1/notifications");
    expect(all.statusCode).toBe(200);
    const body = all.json<{ data: View[]; meta: { pagination: { total: number } } }>();
    expect(body.data.map((n) => n.id)).toEqual([c, b, a]);
    expect(body.data[1]).toMatchObject({
      type: "ALERT_EXPIRED",
      category: "PRICE_ALERTS",
      critical: false,
    });
    const search = data<View[]>(await agent.get("/api/v1/notifications?category=SEARCH"));
    expect(search.map((n) => n.id)).toEqual([c, a]);
    const p2 = data<View[]>(await agent.get("/api/v1/notifications?page=2&pageSize=2"));
    expect(p2.map((n) => n.id)).toEqual([a]);
    expect(
      data<{ unread: number }>(await agent.get("/api/v1/notifications/unread-count")).unread,
    ).toBe(3);
    expect((await agent.get("/api/v1/notifications?category=OTHER")).statusCode).toBe(422);
  });

  it("marks read (PATCH and legacy POST), reads all, deletes; another user's ids are not found", async () => {
    const { agent, userId } = await signUp(ctx, "read@example.com");
    const intruder = await signUp(ctx, "intruder@example.com");
    const a = await notify(userId);
    const b = await notify(userId);
    const c = await notify(userId);

    for (const res of [
      await intruder.agent.patch(`/api/v1/notifications/${a}/read`, {}),
      await intruder.agent.post(`/api/v1/notifications/${a}/read`),
      await intruder.agent.delete(`/api/v1/notifications/${a}`),
    ])
      expect(res.statusCode).toBe(404);
    expect(
      data<{ updated: number }>(await intruder.agent.post("/api/v1/notifications/read-all"))
        .updated,
    ).toBe(0);
    expect(await ctx.prisma.notification.count({ where: { userId, readAt: { not: null } } })).toBe(
      0,
    );

    const r = data<View>(await agent.patch(`/api/v1/notifications/${a}/read`, {}));
    expect(r.readAt).not.toBeNull();
    expect((await agent.post(`/api/v1/notifications/${b}/read`)).statusCode).toBe(200);
    expect(
      data<{ updated: number }>(await agent.post("/api/v1/notifications/read-all")).updated,
    ).toBe(1);
    expect(
      data<{ unread: number }>(await agent.get("/api/v1/notifications/unread-count")).unread,
    ).toBe(0);

    expect((await agent.delete(`/api/v1/notifications/${c}`)).statusCode).toBe(204);
    expect((await agent.delete(`/api/v1/notifications/${c}`)).statusCode).toBe(404);
    expect(await ctx.prisma.notificationDelivery.count({ where: { notificationId: c } })).toBe(0);
    expect(
      data<View[]>(await agent.get("/api/v1/notifications"))
        .map((n) => n.id)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it("requires a session", async () => {
    const anon = new Agent(ctx.app);
    expect((await anon.get("/api/v1/notifications")).statusCode).toBe(401);
    expect((await anon.get("/api/v1/notifications/unread-count")).statusCode).toBe(401);
    expect((await anon.get("/api/v1/users/me/notification-preferences")).statusCode).toBe(401);
  });

  it("never creates the same event's notification twice", async () => {
    const { userId } = await signUp(ctx, "dedupe@example.com");
    const event: NotificationEvent = {
      kind: "search.finished",
      userId,
      searchId: "0190a000-0000-7000-8000-00000000dead",
      status: "FAILED",
      query: "x",
      resultCount: 0,
    };
    const once = () =>
      ctx.prisma.$transaction((tx) =>
        recordNotification(tx, buildNotification(event), { now: new Date() }),
      );
    const results = await Promise.all([once(), once(), once()]);
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(await ctx.prisma.notification.count({ where: { userId } })).toBe(1);
  });
});

describe("preferences", () => {
  it("returns defaults, merges partial updates, keeps account notices in-app and validates input", async () => {
    const { agent } = await signUp(ctx, "prefs@example.com");
    const d = data<Record<string, unknown>>(
      await agent.get("/api/v1/users/me/notification-preferences"),
    );
    expect(d).toEqual({
      inAppEnabled: true,
      emailEnabled: true,
      pushEnabled: false,
      categories: {
        PRICE_ALERTS: { inApp: true, email: true, push: true },
        SEARCH: { inApp: true, email: false, push: false },
        ACCOUNT: { inApp: true, email: false, push: true },
        BILLING: { inApp: true, email: true, push: false },
      },
      quietHours: null,
      timezone: "Asia/Kolkata",
      language: "en-IN",
      pushSubscriptions: 0,
    });
    const u = data<Record<string, unknown>>(
      await agent.patch("/api/v1/users/me/notification-preferences", {
        pushEnabled: true,
        categories: { SEARCH: { email: true }, ACCOUNT: { inApp: false, email: true } },
        quietHours: { start: "22:00", end: "07:00" },
        timezone: "Europe/London",
      }),
    );
    expect(u).toMatchObject({
      pushEnabled: true,
      emailEnabled: true,
      categories: {
        PRICE_ALERTS: { inApp: true, email: true, push: true },
        SEARCH: { inApp: true, email: true, push: false },
        ACCOUNT: { inApp: true, email: false, push: true },
      },
      quietHours: { start: "22:00", end: "07:00" },
      timezone: "Europe/London",
    });
    for (const bad of [
      { quietHours: { start: "25:00", end: "07:00" } },
      { quietHours: { start: "07:00", end: "07:00" } },
      { timezone: "Mars/Olympus" },
      { categories: { MARKETING: { email: true } } },
      { language: "fr-FR" },
      { userId: "someone-else" },
      {},
    ])
      expect((await agent.patch("/api/v1/users/me/notification-preferences", bad)).statusCode).toBe(
        422,
      );
    const cleared = data<{ quietHours: unknown }>(
      await agent.patch("/api/v1/users/me/notification-preferences", { quietHours: null }),
    );
    expect(cleared.quietHours).toBeNull();
  });
});

describe("one-click unsubscribe", () => {
  it("turns off only that category's email for the token's user; rejects forged and expired tokens", async () => {
    const { userId } = await signUp(ctx, "unsub@example.com");
    const other = await signUp(ctx, "unsub-other@example.com");
    const anon = new Agent(ctx.app);
    const token = createUnsubscribeToken(SECRET, userId, "PRICE_ALERTS");
    const res = await anon.post("/api/v1/notifications/unsubscribe", { token });
    expect(res.statusCode).toBe(200);
    expect(data(res)).toEqual({ category: "PRICE_ALERTS", channel: "email" });
    const prefs = data<{ emailEnabled: boolean; categories: Record<string, { email: boolean }> }>(
      await (
        await signUpAgain("unsub@example.com")
      ).get("/api/v1/users/me/notification-preferences"),
    );
    expect(prefs.emailEnabled).toBe(true);
    expect(prefs.categories.PRICE_ALERTS!.email).toBe(false);
    expect(prefs.categories.SEARCH!.email).toBe(false); // default, untouched
    // The other user is unaffected.
    expect(
      data<{ categories: Record<string, { email: boolean }> }>(
        await other.agent.get("/api/v1/users/me/notification-preferences"),
      ).categories.PRICE_ALERTS!.email,
    ).toBe(true);

    const forged = createUnsubscribeToken("x".repeat(40), other.userId, "PRICE_ALERTS");
    expect(
      (await anon.post("/api/v1/notifications/unsubscribe", { token: forged })).statusCode,
    ).toBe(400);
    const expired = createUnsubscribeToken(
      SECRET,
      other.userId,
      "PRICE_ALERTS",
      new Date(Date.now() - 400 * 86_400_000),
    );
    expect(
      (await anon.post("/api/v1/notifications/unsubscribe", { token: expired })).statusCode,
    ).toBe(400);
  });
});

async function signUpAgain(email: string) {
  const agent = new Agent(ctx.app);
  await agent.post("/api/v1/auth/login", { email, password: PASSWORD });
  return agent;
}

describe("browser push subscriptions", () => {
  const sub = (n: number) => ({
    endpoint: `https://push.example.com/send/${n}`,
    expirationTime: null,
    keys: {
      p256dh:
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
  });

  it("exposes the public key, stores, moves and revokes subscriptions per user", async () => {
    const anon = new Agent(ctx.app);
    expect(data(await anon.get("/api/v1/push/config"))).toEqual({ publicKey: VAPID.publicKey });
    expect((await anon.post("/api/v1/push/subscribe", sub(1))).statusCode).toBe(401);

    const a = await signUp(ctx, "push-a@example.com");
    const b = await signUp(ctx, "push-b@example.com");
    expect((await a.agent.post("/api/v1/push/subscribe", sub(1))).statusCode).toBe(201);
    expect((await a.agent.post("/api/v1/push/subscribe", sub(1))).statusCode).toBe(201); // refresh
    expect(await ctx.prisma.pushSubscription.count()).toBe(1);
    expect(
      (
        await a.agent.post("/api/v1/push/subscribe", {
          ...sub(2),
          endpoint: "http://push.example.com/x",
        })
      ).statusCode,
    ).toBe(422);

    // B can't revoke A's subscription…
    expect(
      (await b.agent.request("DELETE", "/api/v1/push/subscribe", { endpoint: sub(1).endpoint }))
        .statusCode,
    ).toBe(404);
    // …but the same browser signed in as B takes it over.
    await b.agent.post("/api/v1/push/subscribe", sub(1));
    const row = await ctx.prisma.pushSubscription.findUniqueOrThrow({
      where: { endpoint: sub(1).endpoint },
    });
    expect(row.userId).toBe(b.userId);
    expect(
      data<{ pushSubscriptions: number }>(
        await a.agent.get("/api/v1/users/me/notification-preferences"),
      ).pushSubscriptions,
    ).toBe(0);

    expect(
      (await b.agent.request("DELETE", "/api/v1/push/subscribe", { endpoint: sub(1).endpoint }))
        .statusCode,
    ).toBe(204);
    expect(
      (await ctx.prisma.pushSubscription.findUniqueOrThrow({ where: { id: row.id } })).revokedAt,
    ).not.toBeNull();
  });
});

describe("account events (verified sources)", () => {
  it("notifies a password change in-app even with in-app turned off, never by DealMind email", async () => {
    const { agent, userId } = await signUp(ctx, "pw@example.com");
    await agent.patch("/api/v1/users/me/notification-preferences", { inAppEnabled: false });
    const res = await agent.post("/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: "Changed-pass-99!",
    });
    expect(res.statusCode).toBe(200);
    const n = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId, type: "PASSWORD_CHANGED" },
      include: { deliveries: true },
    });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: "auth.password_changed", actorId: userId },
    });
    expect(n).toMatchObject({
      critical: true,
      category: "ACCOUNT",
      sourceType: "ACCOUNT",
      sourceId: audit.id,
    });
    expect(Object.fromEntries(n.deliveries.map((d) => [d.channel, d.status]))).toEqual({
      IN_APP: "SENT",
      EMAIL: "SKIPPED",
      PUSH: "SKIPPED",
    });
    const list = data<View[]>(await agent.get("/api/v1/notifications"));
    expect(list.map((x) => x.type)).toContain("PASSWORD_CHANGED");
  });

  it("notifies a sign-in from a new device only, and enqueues its push delivery", async () => {
    const { agent, userId } = await signUp(ctx, "device@example.com");
    // First-ever sign-in of a new account: no notice.
    expect(await ctx.prisma.notification.count({ where: { userId } })).toBe(0);
    await agent.patch("/api/v1/users/me/notification-preferences", { pushEnabled: true });
    await agent.post("/api/v1/push/subscribe", {
      endpoint: "https://push.example.com/send/dev",
      keys: {
        p256dh:
          "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
        auth: "tBHItJI5svbpez7KI4CCXg",
      },
    });

    // Same device again: no notice.
    await new Agent(ctx.app).post("/api/v1/auth/login", {
      email: "device@example.com",
      password: PASSWORD,
    });
    expect(await ctx.prisma.notification.count({ where: { userId } })).toBe(0);

    const phone = new Agent(
      ctx.app,
      APP_ORIGIN,
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
    );
    expect(
      (await phone.post("/api/v1/auth/login", { email: "device@example.com", password: PASSWORD }))
        .statusCode,
    ).toBe(200);
    const n = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId },
      include: { deliveries: true },
    });
    expect(n).toMatchObject({ type: "NEW_SIGN_IN", critical: true });
    expect(n.body).toContain("Chrome on Android");
    expect(n.body).not.toContain("Mozilla");
    const push = n.deliveries.find((d) => d.channel === "PUSH")!;
    expect(push.status).toBe("PENDING");
    const q = new Queue(QueueName.notificationDelivery, {
      connection: { url: testRedisUrl() } as never,
      prefix: `${ctx.prefix}:bull`,
    });
    try {
      expect(await q.getJob(`delivery.${push.id}`)).toBeTruthy();
    } finally {
      await q.close();
    }
  });
});

describe("live stream (SSE)", () => {
  it("sends ready with the unread count, then only the caller's changes", async () => {
    const { agent, userId } = await signUp(ctx, "live@example.com");
    const other = await signUp(ctx, "live-other@example.com");
    await notify(userId);
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = ctx.app.server.address() as AddressInfo;
    const cookie = [...agent.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/notifications/stream`, {
      headers: { cookie, origin: APP_ORIGIN },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    // One outstanding read at a time: a read that outlives a timeout keeps its chunk.
    let pending: ReturnType<typeof reader.read> | null = null;
    const until = async (re: RegExp, ms = 3_000) => {
      const end = Date.now() + ms;
      while (!re.test(text) && Date.now() < end) {
        pending ??= reader.read();
        const chunk = await Promise.race([
          pending,
          new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, end - Date.now()))),
        ]);
        if (!chunk) break;
        pending = null;
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value as Uint8Array);
      }
      return re.test(text);
    };
    expect(await until(/event: ready\ndata: \{"unread":1\}/)).toBe(true);

    // Another user's signal never reaches this stream.
    const theirs = await notify(other.userId);
    await publishSignal(ctx.redis, ctx.prefix, other.userId, { type: "created", id: theirs });
    expect(await until(/event: change/, 400)).toBe(false);

    const mine = await notify(userId);
    await publishSignal(ctx.redis, ctx.prefix, userId, { type: "created", id: mine });
    const changed = await until(/event: change\ndata: .*"unread":2/);
    expect(changed).toBe(true);
    expect(text).toContain(mine);
    expect(text).not.toContain(theirs);
    abort.abort();
  });
});

describe("admin observability", () => {
  it("returns delivery aggregates to admins only, without notification contents", async () => {
    const { userId } = await signUp(ctx, "obs-user@example.com");
    const user = await signUpAgain("obs-user@example.com");
    const admin = await signUp(ctx, "obs-admin@example.com", { role: "ADMIN" });
    await notify(userId, "expired");
    expect((await user.get("/api/v1/admin/notifications")).statusCode).toBe(403);
    const res = await admin.agent.get("/api/v1/admin/notifications?hours=24");
    expect(res.statusCode).toBe(200);
    const body = data<{
      deliveries: Record<string, Record<string, number>>;
      notificationsByType: Record<string, number>;
      pushSubscriptions: { active: number };
    }>(res);
    expect(body.deliveries.IN_APP).toEqual({ SENT: 1 });
    expect(body.deliveries.EMAIL).toEqual({ PENDING: 1 });
    expect(body.notificationsByType).toEqual({ ALERT_EXPIRED: 1 });
    expect(res.body).not.toContain("Acme Nova 7");
    expect(res.body).not.toContain(userId);
  });
});
