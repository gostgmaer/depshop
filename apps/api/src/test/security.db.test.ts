/**
 * Phase 7.1 security tests (API). Complements the per-feature isolation tests
 * (searches, results, watchlists, alerts, notifications, billing, agent
 * context) with: session IDOR, mass assignment / privilege escalation,
 * client-supplied ids, transport protections (headers, CORS, CSRF, body
 * limit, safe errors), push-endpoint SSRF, internal-API authentication, and
 * the privacy workflows (data export, account deletion).
 */
import { randomUUID } from "node:crypto";
import { seedReferenceData } from "@dealmind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  Agent,
  PASSWORD,
  type TestContext,
  createTestApp,
  deleteRedisPrefix,
  signUp,
  truncateAll,
} from "./harness.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp({
    INTERNAL_API_TOKEN: "i".repeat(40),
    AGENT_USER_CONTEXT_SECRET: "c".repeat(40),
  });
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  await seedReferenceData(ctx.prisma);
  await deleteRedisPrefix(ctx.redis, ctx.prefix);
  ctx.iam.reset();
});

const two = async () => ({
  a: await signUp(ctx, `a-${randomUUID().slice(0, 8)}@example.com`),
  b: await signUp(ctx, `b-${randomUUID().slice(0, 8)}@example.com`),
});

describe("authorization: IDOR and privilege escalation", () => {
  it("can't revoke or list another user's sessions", async () => {
    const { a, b } = await two();
    const bSession = await ctx.prisma.userSession.findFirstOrThrow({ where: { userId: b.userId } });
    const res = await a.agent.request("DELETE", `/api/v1/users/me/sessions/${bSession.id}`);
    expect(res.statusCode).toBe(404);
    expect(
      (await ctx.prisma.userSession.findUniqueOrThrow({ where: { id: bSession.id } })).revokedAt,
    ).toBeNull();
    const list = await a.agent.get("/api/v1/users/me/sessions");
    expect(list.body).not.toContain(bSession.id);
    expect((await b.agent.get("/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("ignores role and id fields in profile updates (mass assignment) and keeps USER out of admin routes", async () => {
    const { a, b } = await two();
    const bad = await a.agent.patch("/api/v1/users/me", { name: "Asha", role: "ADMIN" });
    expect(bad.statusCode).toBe(422);
    const other = await a.agent.patch("/api/v1/users/me", { name: "Asha", id: b.userId });
    expect(other.statusCode).toBe(422);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).role).toBe(
      "USER",
    );
    expect(
      (await a.agent.patch(`/api/v1/admin/users/${a.userId}/role`, { role: "ADMIN" })).statusCode,
    ).toBe(403);
    expect((await a.agent.get("/api/v1/admin/users")).statusCode).toBe(403);
    // A forged header can't change who the caller is.
    const forged = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        "x-user-id": b.userId,
        cookie: [...a.agent.jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    expect(forged.json<{ data: { user: { id: string } } }>().data.user.id).toBe(a.userId);
  });

  it("rejects a client-supplied owner id when creating records", async () => {
    const { a, b } = await two();
    const res = await a.agent.post("/api/v1/watchlists", { name: "Mine", userId: b.userId });
    expect(res.statusCode).toBe(422);
    expect(await ctx.prisma.watchlist.count({ where: { userId: b.userId } })).toBe(0);
  });

  it("doesn't let one user unsubscribe another user's browser", async () => {
    const { a, b } = await two();
    const endpoint = "https://fcm.googleapis.com/fcm/send/b-device";
    await ctx.prisma.pushSubscription.create({
      data: { userId: b.userId, endpoint, p256dh: "p", auth: "a" },
    });
    const res = await a.agent.request("DELETE", "/api/v1/push/subscribe", { endpoint });
    expect(res.statusCode).toBe(404);
    expect(
      (await ctx.prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint } })).revokedAt,
    ).toBeNull();
  });
});

describe("SSRF: push endpoints", () => {
  it("accepts browser push services only", async () => {
    const { a } = await two();
    const keys = {
      p256dh:
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    };
    for (const endpoint of [
      "https://10.0.0.5/push",
      "https://localhost/push",
      "https://internal-api:443/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user:pw@fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x",
      "http://fcm.googleapis.com/fcm/send/x",
    ]) {
      const res = await a.agent.post("/api/v1/push/subscribe", { endpoint, keys });
      expect(res.statusCode, endpoint).toBe(422);
    }
    expect(await ctx.prisma.pushSubscription.count()).toBe(0);
  });
});

describe("transport protections", () => {
  it("sends security headers and no framework fingerprint", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/health/live" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("gives no CORS grant to unknown origins and blocks cross-origin writes", async () => {
    const pre = await ctx.app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/login",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const evil = new Agent(ctx.app, "https://evil.example");
    const res = await evil.post("/api/v1/auth/login", {
      email: "x@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("CSRF_INVALID");
  });

  it("refuses oversized bodies and malformed JSON with a safe error envelope", async () => {
    // Without a CSRF token the request is refused before the body is read.
    const anon = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      payload: `{"email":"${"a".repeat(1_100_000)}"}`,
    });
    expect(anon.statusCode).toBe(403);
    const { a } = await two();
    await a.agent.get("/api/v1/auth/csrf");
    const headers = {
      origin: APP_ORIGIN,
      "content-type": "application/json",
      cookie: [...a.agent.jar].map(([k, v]) => `${k}=${v}`).join("; "),
      "x-csrf-token": a.agent.cookie("dm_csrf") ?? "",
    };
    const big = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/watchlists",
      headers,
      payload: `{"name":"${"a".repeat(1_100_000)}"}`,
    });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ success: boolean }>().success).toBe(false);
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/watchlists",
      headers,
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    const body = bad.json<{
      success: boolean;
      error: { code: string; message: string };
      meta: { requestId: string };
    }>();
    expect(body.success).toBe(false);
    expect(body.meta.requestId).toBeTruthy();
    expect(body.error.message).not.toMatch(/at \w+ \(|node_modules|prisma/i);
  });

  it("treats SQL metacharacters in search input as plain text", async () => {
    const { a } = await two();
    const res = await a.agent.get(
      `/api/v1/search?q=${encodeURIComponent('\'; DROP TABLE "User"; --')}`,
    );
    expect([200, 422]).toContain(res.statusCode);
    expect(await ctx.prisma.user.count()).toBe(2);
  });

  it("keeps the internal service API behind its token", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${"i".repeat(39)}`]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/internal/v1/categories",
        headers: authorization ? { authorization } : {},
      });
      expect(res.statusCode).toBe(401);
    }
    // Not reachable under the public /api prefix either.
    expect(
      (await ctx.app.inject({ method: "GET", url: "/api/v1/internal/categories" })).statusCode,
    ).toBe(404);
  });
});

describe("privacy: data export", () => {
  it("exports only the caller's data and no security material", async () => {
    const { a, b } = await two();
    await ctx.prisma.search.create({
      data: { userId: a.userId, query: "a's phone search", status: "COMPLETED" },
    });
    await ctx.prisma.search.create({
      data: { userId: b.userId, query: "b's private search", status: "COMPLETED" },
    });
    await ctx.prisma.pushSubscription.create({
      data: {
        userId: a.userId,
        endpoint: "https://fcm.googleapis.com/fcm/send/a",
        p256dh: "P256DH-SECRET-KEY",
        auth: "AUTH-SECRET",
      },
    });
    const res = await a.agent.get("/api/v1/users/me/export");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["cache-control"]).toBe("no-store");
    const data = res.json<{
      profile: { id: string };
      searches: { query: string }[];
      sessions: unknown[];
    }>();
    expect(data.profile.id).toBe(a.userId);
    expect(data.searches.map((s) => s.query)).toEqual(["a's phone search"]);
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(res.body).not.toContain("b's private search");
    expect(res.body).not.toContain(b.userId);
    for (const secret of [
      "tokenHash",
      "iamAccessTokenEnc",
      "iamRefreshTokenEnc",
      "P256DH-SECRET-KEY",
      "AUTH-SECRET",
      "ipHash",
      "familyId",
    ])
      expect(res.body, secret).not.toContain(secret);
  });
});

describe("privacy: account deletion", () => {
  const CONFIRM = "DELETE MY ACCOUNT";

  it("requires the typed confirmation and the correct password", async () => {
    const { a } = await two();
    expect((await a.agent.post("/api/v1/users/me/delete", { password: PASSWORD })).statusCode).toBe(
      422,
    );
    expect(
      (
        await a.agent.post("/api/v1/users/me/delete", {
          password: "wrong-password",
          confirm: CONFIRM,
        })
      ).statusCode,
    ).toBe(400);
    expect(await ctx.prisma.user.count({ where: { id: a.userId } })).toBe(1);
  });

  it("refuses while a paid subscription is still renewing", async () => {
    const { a } = await two();
    await ctx.prisma.subscription.upsert({
      where: { userId: a.userId },
      create: {
        userId: a.userId,
        planCode: "PRO",
        status: "ACTIVE",
        interval: "MONTHLY",
        provider: "sandbox",
        providerSubscriptionId: "s-1",
        currentPeriodEnd: new Date(Date.now() + 9e8),
      },
      update: {
        planCode: "PRO",
        status: "ACTIVE",
        interval: "MONTHLY",
        provider: "sandbox",
        providerSubscriptionId: "s-1",
        currentPeriodEnd: new Date(Date.now() + 9e8),
      },
    });
    const res = await a.agent.post("/api/v1/users/me/delete", {
      password: PASSWORD,
      confirm: CONFIRM,
    });
    expect(res.statusCode).toBe(409);
    expect(await ctx.prisma.user.count({ where: { id: a.userId } })).toBe(1);
  });

  it("deletes the caller's data, detaches retained records, ends sessions and leaves other users intact", async () => {
    const { a, b } = await two();
    await ctx.prisma.search.create({ data: { userId: a.userId, query: "a", status: "COMPLETED" } });
    await ctx.prisma.watchlist.create({ data: { userId: a.userId, name: "A list" } });
    await ctx.prisma.search.create({ data: { userId: b.userId, query: "b", status: "COMPLETED" } });
    await ctx.prisma.watchlist.create({ data: { userId: b.userId, name: "B list" } });
    const ev = await ctx.prisma.billingEvent.create({
      data: {
        userId: a.userId,
        type: "WEBHOOK_RECEIVED",
        provider: "easydev-payments",
        providerEventId: `e-${randomUUID()}`,
        occurredAt: new Date(),
      } as never,
    });
    const res = await a.agent.post("/api/v1/users/me/delete", {
      password: PASSWORD,
      confirm: CONFIRM,
    });
    expect(res.statusCode).toBe(204);
    expect(await ctx.prisma.user.count({ where: { id: a.userId } })).toBe(0);
    expect(await ctx.prisma.search.count({ where: { userId: a.userId } })).toBe(0);
    expect(await ctx.prisma.watchlist.count({ where: { userId: a.userId } })).toBe(0);
    expect(await ctx.prisma.userSession.count({ where: { userId: a.userId } })).toBe(0);
    expect(
      (await ctx.prisma.billingEvent.findUniqueOrThrow({ where: { id: ev.id } })).userId,
    ).toBeNull();
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: "account.deleted" },
    });
    expect(audit).toMatchObject({ actorId: null, entityId: a.userId });
    expect(JSON.stringify(audit.metadata)).not.toContain("@example.com");
    // The old cookie no longer works; the other user is untouched.
    expect((await a.agent.get("/api/v1/auth/me")).statusCode).toBe(401);
    expect(await ctx.prisma.search.count({ where: { userId: b.userId } })).toBe(1);
    expect(await ctx.prisma.watchlist.count({ where: { userId: b.userId } })).toBe(1);
    expect((await b.agent.get("/api/v1/auth/me")).statusCode).toBe(200);
  });
});
