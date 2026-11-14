/**
 * Authentication & authorization integration tests: real Fastify app, real
 * PostgreSQL (*_api_test), real cookies and CSRF. The numbered describes map
 * to the Phase 1.4 test requirements.
 */
import { createHash } from "node:crypto";
import type { ErrorResponseBody, MeResponse, SessionsResponse } from "@dealmind/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  PASSWORD,
  type TestContext,
  createTestApp,
  signUp,
  tokenFromEmail,
  truncateAll,
} from "./harness.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const errorOf = (res: { json: <T>() => T }) => res.json<ErrorResponseBody>().error;

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await truncateAll(ctx.prisma);
  ctx.mail.clear();
});

describe("1. registration", () => {
  it("creates an unverified user with Argon2id hash, preferences, FREE plan and a hashed verification token", async () => {
    const agent = new Agent(ctx.app);
    const res = await agent.post("/api/v1/auth/register", {
      email: "Asha@Example.com",
      password: PASSWORD,
      name: "Asha",
    });
    expect(res.statusCode).toBe(202);
    expect(agent.cookie("dm_session")).toBeUndefined(); // registration does not sign in

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: "asha@example.com" },
      include: { preference: true, subscription: true },
    });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.preference).not.toBeNull();
    expect(user.subscription?.planCode).toBe("FREE");

    const [mail] = ctx.mail.to("asha@example.com");
    expect(mail?.subject).toMatch(/verify/i);
    const token = tokenFromEmail(ctx.mail, "asha@example.com");
    expect(mail?.text).toContain(`http://localhost:3000/verify-email?token=${token}`);
    const stored = await ctx.prisma.authToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).toBe(sha256(token)); // only the hash is stored
    expect(stored.tokenHash).not.toContain(token);
  });

  it("rejects weak passwords and client-supplied privilege fields", async () => {
    const agent = new Agent(ctx.app);
    const weak = await agent.post("/api/v1/auth/register", {
      email: "a@b.co",
      password: "short",
      name: "A",
    });
    expect(weak.statusCode).toBe(422);
    const sneaky = await agent.post("/api/v1/auth/register", {
      email: "a@b.co",
      password: PASSWORD,
      name: "A",
      role: "ADMIN",
    });
    expect(sneaky.statusCode).toBe(422);
    expect(await ctx.prisma.user.count()).toBe(0);
  });
});

describe("2. duplicate registration", () => {
  it("responds identically, creates nothing, and notifies the real owner", async () => {
    const agent = new Agent(ctx.app);
    const body = { email: "dup@example.com", password: PASSWORD, name: "Dup" };
    const first = await agent.post("/api/v1/auth/register", body);
    const second = await agent.post("/api/v1/auth/register", { ...body, name: "Attacker" });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json()); // no account enumeration
    expect(await ctx.prisma.user.count()).toBe(1);
    expect((await ctx.prisma.user.findFirstOrThrow()).name).toBe("Dup");
    const subjects = ctx.mail.to("dup@example.com").map((m) => m.subject);
    expect(subjects).toHaveLength(2);
    expect(subjects[1]).toMatch(/tried to create/i);
    expect(await ctx.prisma.authToken.count()).toBe(1);
  });
});

describe("3. login", () => {
  it("sets an HttpOnly, SameSite=Lax session cookie and never returns secrets", async () => {
    await signUp(ctx, "login@example.com");
    const agent = new Agent(ctx.app);
    const res = await agent.post("/api/v1/auth/login", {
      email: "LOGIN@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(200);

    const cookie = (
      res.cookies as {
        name: string;
        httpOnly?: boolean;
        sameSite?: string;
        path?: string;
        secure?: boolean;
        maxAge?: number;
      }[]
    ).find((c) => c.name === "dm_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie?.maxAge).toBe(30 * 86_400);
    expect(res.body).not.toMatch(/passwordHash|tokenHash|argon2/);
    expect(res.json<MeResponse>().user).toMatchObject({
      email: "login@example.com",
      role: "USER",
      emailVerified: true,
    });

    const raw = agent.cookie("dm_session") ?? "";
    expect(await ctx.prisma.userSession.count({ where: { tokenHash: sha256(raw) } })).toBe(1);
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("uses __Host- prefixed Secure cookies when COOKIE_SECURE=true", async () => {
    const secure = await createTestApp({ COOKIE_SECURE: "true" });
    try {
      await signUp(secure, "secure@example.com");
      const agent = new Agent(secure.app);
      const res = await agent.post("/api/v1/auth/login", {
        email: "secure@example.com",
        password: PASSWORD,
      });
      const names = (res.cookies as { name: string; secure?: boolean }[]).map((c) => [
        c.name,
        c.secure,
      ]);
      expect(names).toContainEqual(["__Host-dm_session", true]);
      expect(names).toContainEqual(["__Host-dm_csrf", true]);
    } finally {
      await secure.close();
    }
  });

  it("rotates the session identifier on login (session fixation defence)", async () => {
    const { agent } = await signUp(ctx, "fixation@example.com");
    const before = agent.cookie("dm_session");
    await agent.post("/api/v1/auth/login", { email: "fixation@example.com", password: PASSWORD });
    const after = agent.cookie("dm_session");
    expect(after).not.toBe(before);
    const old = await ctx.prisma.userSession.findUniqueOrThrow({
      where: { tokenHash: sha256(before ?? "") },
    });
    expect(old.revokedAt).not.toBeNull();
  });
});

describe("4. incorrect password", () => {
  it("returns the same generic 401 for a wrong password and an unknown email", async () => {
    await signUp(ctx, "victim@example.com");
    const agent = new Agent(ctx.app);
    const wrong = await agent.post("/api/v1/auth/login", {
      email: "victim@example.com",
      password: "wrong-pass-1",
    });
    const unknown = await agent.post("/api/v1/auth/login", {
      email: "nobody@example.com",
      password: "wrong-pass-1",
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(errorOf(wrong).message).toBe(errorOf(unknown).message);
    expect(agent.cookie("dm_session")).toBeUndefined();
  });

  it("locks an account after repeated failures, even for the right password", async () => {
    await signUp(ctx, "locked@example.com");
    const agent = new Agent(ctx.app);
    for (let i = 0; i < 5; i += 1) {
      await agent.post("/api/v1/auth/login", {
        email: "locked@example.com",
        password: "wrong-pass-1",
      });
    }
    const res = await agent.post("/api/v1/auth/login", {
      email: "locked@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(429);
  });

  it("rejects a suspended user's correct password", async () => {
    const { userId } = await signUp(ctx, "suspended@example.com");
    await ctx.prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });
    const res = await new Agent(ctx.app).post("/api/v1/auth/login", {
      email: "suspended@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("5. logout", () => {
  it("revokes the session server-side and clears the cookie", async () => {
    const { agent } = await signUp(ctx, "bye@example.com");
    const stolen = agent.cookie("dm_session") ?? "";
    const res = await agent.post("/api/v1/auth/logout");
    expect(res.statusCode).toBe(204);
    expect(agent.cookie("dm_session")).toBeUndefined();

    // Replaying the old cookie value must not work.
    const replay = new Agent(ctx.app);
    replay.jar.set("dm_session", stolen);
    expect((await replay.get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

describe("6. expired sessions", () => {
  it("rejects sessions past their absolute expiry", async () => {
    const { agent, userId } = await signUp(ctx, "expired@example.com");
    await ctx.prisma.userSession.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1_000), createdAt: new Date(Date.now() - 10_000) },
    });
    const res = await agent.get("/api/v1/auth/me");
    expect(res.statusCode).toBe(401);
    expect(agent.cookie("dm_session")).toBeUndefined(); // dead cookie cleared
  });

  it("rejects sessions idle longer than the idle timeout", async () => {
    const { agent, userId } = await signUp(ctx, "idle@example.com");
    await ctx.prisma.userSession.updateMany({
      where: { userId },
      data: { lastUsedAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

describe("7. email verification", () => {
  it("verifies once; tokens are single-use, expire, and are replaced on resend", async () => {
    const { agent } = await signUp(ctx, "verify@example.com", { verify: false });
    expect((await agent.get("/api/v1/auth/me")).json<MeResponse>().user.emailVerified).toBe(false);

    const first = tokenFromEmail(ctx.mail, "verify@example.com");
    expect((await agent.post("/api/v1/auth/resend-verification")).statusCode).toBe(200);
    const second = tokenFromEmail(ctx.mail, "verify@example.com");
    expect(second).not.toBe(first);
    expect((await agent.post("/api/v1/auth/verify-email", { token: first })).statusCode).toBe(400); // superseded

    expect((await agent.post("/api/v1/auth/verify-email", { token: second })).statusCode).toBe(200);
    expect((await agent.get("/api/v1/auth/me")).json<MeResponse>().user.emailVerified).toBe(true);
    expect((await agent.post("/api/v1/auth/verify-email", { token: second })).statusCode).toBe(400); // reused
  });

  it("rejects expired verification tokens", async () => {
    const { agent, userId } = await signUp(ctx, "late@example.com", { verify: false });
    const token = tokenFromEmail(ctx.mail, "late@example.com");
    await ctx.prisma.authToken.updateMany({
      where: { userId },
      data: { createdAt: new Date(Date.now() - 10_000), expiresAt: new Date(Date.now() - 1_000) },
    });
    const res = await agent.post("/api/v1/auth/verify-email", { token });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).message).toMatch(/invalid or has expired/);
  });
});

describe("8. password reset & change", () => {
  it("does not reveal whether an email exists", async () => {
    await signUp(ctx, "known@example.com");
    ctx.mail.clear();
    const agent = new Agent(ctx.app);
    const known = await agent.post("/api/v1/auth/forgot-password", { email: "known@example.com" });
    const unknown = await agent.post("/api/v1/auth/forgot-password", {
      email: "ghost@example.com",
    });
    expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
    expect(known.json()).toEqual(unknown.json());
    expect(ctx.mail.to("known@example.com")).toHaveLength(1);
    expect(ctx.mail.to("ghost@example.com")).toHaveLength(0);
  });

  it("resets the password with a single-use token and signs out every session", async () => {
    const { agent: laptop } = await signUp(ctx, "reset@example.com");
    const phone = new Agent(ctx.app);
    await phone.post("/api/v1/auth/login", { email: "reset@example.com", password: PASSWORD });

    const anon = new Agent(ctx.app);
    await anon.post("/api/v1/auth/forgot-password", { email: "reset@example.com" });
    const token = tokenFromEmail(ctx.mail, "reset@example.com");
    const res = await anon.post("/api/v1/auth/reset-password", {
      token,
      password: "brand-new-pass-7",
    });
    expect(res.statusCode).toBe(200);
    expect(
      (await anon.post("/api/v1/auth/reset-password", { token, password: "another-pass-8" }))
        .statusCode,
    ).toBe(400);

    expect((await laptop.get("/api/v1/auth/me")).statusCode).toBe(401);
    expect((await phone.get("/api/v1/auth/me")).statusCode).toBe(401);
    const login = (password: string) =>
      new Agent(ctx.app).post("/api/v1/auth/login", { email: "reset@example.com", password });
    expect((await login(PASSWORD)).statusCode).toBe(401);
    expect((await login("brand-new-pass-7")).statusCode).toBe(200);
    expect(ctx.mail.to("reset@example.com").at(-1)?.subject).toMatch(/password was changed/i);
  });

  it("changes the password, revokes other sessions and rotates the current one", async () => {
    const { agent: laptop } = await signUp(ctx, "change@example.com");
    const phone = new Agent(ctx.app);
    await phone.post("/api/v1/auth/login", { email: "change@example.com", password: PASSWORD });
    const before = laptop.cookie("dm_session") ?? "";

    const wrong = await laptop.post("/api/v1/auth/change-password", {
      currentPassword: "not-my-password-1",
      newPassword: "changed-pass-99",
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await laptop.post("/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: "changed-pass-99",
    });
    expect(ok.statusCode).toBe(200);
    expect(laptop.cookie("dm_session")).not.toBe(before); // rotated
    expect((await laptop.get("/api/v1/auth/me")).statusCode).toBe(200);
    expect((await phone.get("/api/v1/auth/me")).statusCode).toBe(401);
  });

  it("treats replay of a rotated-away session token as theft and revokes the family", async () => {
    const { agent } = await signUp(ctx, "theft@example.com");
    const old = agent.cookie("dm_session") ?? "";
    await agent.post("/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: "changed-pass-99",
    });

    const attacker = new Agent(ctx.app);
    attacker.jar.set("dm_session", old);
    expect((await attacker.get("/api/v1/auth/me")).statusCode).toBe(401);
    // The legitimate (rotated) session in the same family is revoked too.
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

describe("9. protected routes", () => {
  it.each([
    ["GET", "/api/v1/auth/me"],
    ["GET", "/api/v1/auth/sessions"],
    ["GET", "/api/v1/users/me/preferences"],
    ["PATCH", "/api/v1/users/me"],
    ["POST", "/api/v1/auth/logout"],
    ["POST", "/api/v1/auth/resend-verification"],
  ] as const)("%s %s requires a session", async (method, url) => {
    const res = await new Agent(ctx.app).request(
      method,
      url,
      method === "GET" ? undefined : { name: "x" },
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe("UNAUTHENTICATED");
  });

  it("rejects forged session cookies", async () => {
    const agent = new Agent(ctx.app);
    agent.jar.set("dm_session", "forged-value-that-is-not-a-real-session");
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

describe("10. USER versus ADMIN", () => {
  it("forbids admin endpoints to users and allows them to admins", async () => {
    const { agent: user } = await signUp(ctx, "plain@example.com");
    const { agent: admin } = await signUp(ctx, "boss@example.com", { role: "ADMIN" });
    expect((await user.get("/api/v1/admin/users")).statusCode).toBe(403);
    const list = await admin.get("/api/v1/admin/users");
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(2);
  });

  it("never infers privileges from client-provided data", async () => {
    const { agent } = await signUp(ctx, "wannabe@example.com");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/users?role=ADMIN",
      headers: {
        cookie: `dm_session=${agent.cookie("dm_session")}`,
        "x-user-role": "ADMIN",
        "x-user-id": "00000000-0000-7000-8000-000000000000",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("applies role changes immediately and rotates the target's sessions", async () => {
    const { agent: admin } = await signUp(ctx, "root@example.com", { role: "ADMIN" });
    const { agent: user, userId } = await signUp(ctx, "promote@example.com");

    const promote = await admin.patch(`/api/v1/admin/users/${userId}/role`, { role: "ADMIN" });
    expect(promote.statusCode).toBe(200);
    expect((await user.get("/api/v1/auth/me")).statusCode).toBe(401); // must re-authenticate
    await user.post("/api/v1/auth/login", { email: "promote@example.com", password: PASSWORD });
    expect((await user.get("/api/v1/admin/users")).statusCode).toBe(200);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.user_role_changed" },
    });
    expect(audit.entityId).toBe(userId);

    const self = await admin.patch(
      `/api/v1/admin/users/${(await ctx.prisma.user.findUniqueOrThrow({ where: { email: "root@example.com" } })).id}/role`,
      { role: "USER" },
    );
    expect(self.statusCode).toBe(403);
  });

  it("demotion and suspension take effect on the very next request", async () => {
    const { agent, userId } = await signUp(ctx, "demoted@example.com", { role: "ADMIN" });
    expect((await agent.get("/api/v1/admin/users")).statusCode).toBe(200);
    await ctx.prisma.user.update({ where: { id: userId }, data: { role: "USER" } });
    expect((await agent.get("/api/v1/admin/users")).statusCode).toBe(403);
    await ctx.prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

describe("11. cross-user private data", () => {
  it("users see and revoke only their own sessions", async () => {
    const { agent: alice, userId: aliceId } = await signUp(ctx, "alice@example.com");
    const { agent: bob } = await signUp(ctx, "bob@example.com");
    const aliceSession = await ctx.prisma.userSession.findFirstOrThrow({
      where: { userId: aliceId, revokedAt: null },
    });

    const bobsView = (await bob.get("/api/v1/auth/sessions")).json<SessionsResponse>();
    expect(bobsView.sessions.map((s) => s.id)).not.toContain(aliceSession.id);

    const attack = await bob.delete(`/api/v1/auth/sessions/${aliceSession.id}`);
    expect(attack.statusCode).toBe(404); // not 403: existence is not leaked
    expect((await alice.get("/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("profile and preference updates only ever touch the caller", async () => {
    const { agent: alice } = await signUp(ctx, "alice2@example.com", { name: "Alice" });
    const { userId: bobId } = await signUp(ctx, "bob2@example.com", { name: "Bob" });

    const smuggled = await alice.patch("/api/v1/users/me/preferences", {
      notifyEmail: false,
      userId: bobId,
    });
    expect(smuggled.statusCode).toBe(422);
    expect(
      (await alice.patch("/api/v1/users/me", { name: "Bob Hacked", userId: bobId })).statusCode,
    ).toBe(422);

    expect(
      (await alice.patch("/api/v1/users/me/preferences", { notifyEmail: false })).statusCode,
    ).toBe(200);
    expect((await alice.patch("/api/v1/users/me", { name: "Alice B" })).statusCode).toBe(200);

    const bob = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: bobId },
      include: { preference: true },
    });
    expect(bob.name).toBe("Bob");
    expect(bob.preference?.notifyEmail).toBe(true);
  });
});

describe("12. session revocation", () => {
  it("lists sessions without secrets and revokes another device", async () => {
    const { agent: laptop } = await signUp(ctx, "devices@example.com");
    const phone = new Agent(ctx.app);
    await phone.post("/api/v1/auth/login", { email: "devices@example.com", password: PASSWORD });

    const res = await laptop.get("/api/v1/auth/sessions");
    expect(res.body).not.toMatch(/tokenHash|familyId|dm_session/);
    const { sessions } = res.json<SessionsResponse>();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    const other = sessions.find((s) => !s.current);
    expect((await laptop.delete(`/api/v1/auth/sessions/${other?.id}`)).statusCode).toBe(204);
    expect((await phone.get("/api/v1/auth/me")).statusCode).toBe(401);
    expect((await laptop.get("/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("revoking the current session signs this browser out", async () => {
    const { agent } = await signUp(ctx, "self@example.com");
    const { sessions } = (await agent.get("/api/v1/auth/sessions")).json<SessionsResponse>();
    const current = sessions.find((s) => s.current);
    expect((await agent.delete(`/api/v1/auth/sessions/${current?.id}`)).statusCode).toBe(204);
    expect(agent.cookie("dm_session")).toBeUndefined();
  });

  it("suspending a user revokes all of their sessions", async () => {
    const { agent: admin } = await signUp(ctx, "mod@example.com", { role: "ADMIN" });
    const { agent: user, userId } = await signUp(ctx, "naughty@example.com");
    await admin.patch(`/api/v1/admin/users/${userId}/status`, { status: "SUSPENDED" });
    expect(await ctx.prisma.userSession.count({ where: { userId, revokedAt: null } })).toBe(0);
    expect((await user.get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

describe("CSRF & origin protection", () => {
  it("rejects state-changing requests without a valid CSRF token", async () => {
    const { agent } = await signUp(ctx, "csrf@example.com");
    const missing = await agent.request("POST", "/api/v1/auth/logout", {}, { csrf: false });
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing).code).toBe("CSRF_INVALID");

    const forged = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        origin: "http://localhost:3000",
        cookie: `dm_session=${agent.cookie("dm_session")}; dm_csrf=abc.def`,
        "x-csrf-token": "abc.def",
      },
    });
    expect(forged.statusCode).toBe(403); // matching but unsigned token
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200); // still signed in
  });

  it("rejects requests from foreign origins even with a valid token", async () => {
    const { agent } = await signUp(ctx, "origin@example.com");
    const evil = new Agent(ctx.app, "https://evil.example");
    for (const [k, v] of agent.jar) evil.jar.set(k, v);
    const res = await evil.post("/api/v1/auth/logout");
    expect(res.statusCode).toBe(403);
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("protects login itself (login CSRF)", async () => {
    await signUp(ctx, "logincsrf@example.com");
    const res = await new Agent(ctx.app).request(
      "POST",
      "/api/v1/auth/login",
      { email: "logincsrf@example.com", password: PASSWORD },
      { csrf: false },
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("preferences", () => {
  it("returns defaults and validates updates", async () => {
    const { agent } = await signUp(ctx, "prefs@example.com");
    expect((await agent.get("/api/v1/users/me/preferences")).json()).toEqual({
      preferredSourceIds: [],
      preferredBrands: [],
      notifyEmail: true,
      notifyInApp: true,
      locale: "en-IN",
    });
    const unknownSource = await agent.patch("/api/v1/users/me/preferences", {
      preferredSourceIds: ["01a1d971-da24-73d0-b4e2-a88d768ceba7"],
    });
    expect(unknownSource.statusCode).toBe(422);
    const ok = await agent.patch("/api/v1/users/me/preferences", {
      preferredBrands: ["Samsung", "Apple", "Samsung"],
      locale: "hi-IN",
    });
    expect(ok.json()).toMatchObject({ preferredBrands: ["Samsung", "Apple"], locale: "hi-IN" });
  });
});

describe("rate limiting", () => {
  it("limits login attempts per IP with the production defaults", async () => {
    const strict = await createTestApp({}, { rateLimits: undefined, loginThrottle: undefined });
    try {
      const agent = new Agent(strict.app);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const res = await agent.post("/api/v1/auth/login", {
          email: `n${i}@example.com`,
          password: "whatever-1",
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await strict.close();
    }
  });
});
