/**
 * Authentication & authorization integration tests: the real Fastify app and
 * real PostgreSQL (*_api_test), with the shared EasyDev IAM replaced by an
 * in-memory fake that reproduces its observed contract (see fake-iam.ts).
 * Numbered describes map to the Phase 1.4 test requirements.
 */
import { createHash } from "node:crypto";
import type { ErrorResponseBody, MeResponse, SessionsResponse } from "@dealmind/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenCipher } from "../lib/token-cipher.js";
import {
  Agent,
  PASSWORD,
  TOKEN_KEY,
  type TestContext,
  createTestApp,
  expireIamAccessTokens,
  signUp,
  tokenFromIam,
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
  ctx.iam.reset();
});

describe("1. registration", () => {
  it("creates the account in the IAM, splits the name, and does not sign in", async () => {
    const agent = new Agent(ctx.app);
    const res = await agent.post("/api/v1/auth/register", {
      email: "Asha@Example.com",
      password: PASSWORD,
      name: "Asha Rao Iyer",
    });
    expect(res.statusCode).toBe(202);
    expect(agent.cookie("dm_session")).toBeUndefined();

    const [call] = ctx.iam.callsTo("/auth/register");
    expect(call?.tenant).toBe("easydev"); // config constant, not a DealMind concept
    expect(call?.body).toEqual({
      email: "asha@example.com",
      password: PASSWORD,
      firstName: "Asha",
      lastName: "Rao Iyer",
      // No displayName: the IAM's RegisterDto rejects unknown properties.
      appUrl: "http://localhost:3000", // DealMind's APP_URL: base for emailed links
    });
    expect(ctx.iam.users.get("asha@example.com")?.verified).toBe(false);
    // The local mirror is created on first sign-in, not at registration.
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it("rejects weak passwords and client-supplied privilege fields before calling the IAM", async () => {
    const agent = new Agent(ctx.app);
    const weak = await agent.post("/api/v1/auth/register", {
      email: "a@b.co",
      password: "short",
      name: "A",
    });
    expect(weak.statusCode).toBe(422);
    const noSpecial = await agent.post("/api/v1/auth/register", {
      email: "a@b.co",
      password: "Correcthorse42",
      name: "A",
    });
    expect(noSpecial.statusCode).toBe(422); // IAM policy needs one of @$!%*?&
    const sneaky = await agent.post("/api/v1/auth/register", {
      email: "a@b.co",
      password: PASSWORD,
      name: "A",
      role: "ADMIN",
    });
    expect(sneaky.statusCode).toBe(422);
    expect(ctx.iam.callsTo("/auth/register")).toHaveLength(0);
  });
});

describe("emailed links", () => {
  it("point to DealMind's pages (APP_URL), not the IAM's global frontend", async () => {
    const agent = new Agent(ctx.app);
    await agent.post("/api/v1/auth/register", {
      email: "links@example.com",
      password: PASSWORD,
      name: "Links",
    });
    expect(ctx.iam.lastVerifyLink.get("links@example.com")).toMatch(
      /^http:\/\/localhost:3000\/verify-email\?token=[A-Za-z0-9_-]+$/,
    );
    await agent.post("/api/v1/auth/forgot-password", { email: "links@example.com" });
    expect(ctx.iam.lastResetLink.get("links@example.com")).toMatch(
      /^http:\/\/localhost:3000\/reset-password\?token=[A-Za-z0-9_-]+$/,
    );
    const { agent: signedIn } = await signUp(ctx, "resend@example.com", { verify: false });
    await signedIn.post("/api/v1/auth/resend-verification");
    expect(ctx.iam.lastVerifyLink.get("resend@example.com")).toMatch(
      /^http:\/\/localhost:3000\/verify-email\?token=/,
    );
    const sent = [
      ...ctx.iam.callsTo("/auth/register"),
      ...ctx.iam.callsTo("/auth/password/forgot"),
      ...ctx.iam.callsTo("/auth/register/send-verification"),
    ];
    expect(
      sent.every((c) => (c.body as { appUrl?: string }).appUrl === "http://localhost:3000"),
    ).toBe(true);
  });

  it("fails loudly (500) when APP_URL is not registered with the IAM, instead of hiding it", async () => {
    const misconfigured = await createTestApp({ APP_URL: "http://unregistered.test" }, {}, ctx.iam);
    try {
      const agent = new Agent(misconfigured.app, "http://unregistered.test");
      const reg = await agent.post("/api/v1/auth/register", {
        email: "nowhere@example.com",
        password: PASSWORD,
        name: "Nowhere",
      });
      expect(reg.statusCode).toBe(500);
      expect(ctx.iam.users.has("nowhere@example.com")).toBe(false); // nothing created
      const forgot = await agent.post("/api/v1/auth/forgot-password", { email: "x@example.com" });
      expect(forgot.statusCode).toBe(500); // not a silent 202
    } finally {
      await misconfigured.close();
    }
  });
});

describe("2. duplicate registration", () => {
  it("responds identically when the IAM reports the account exists", async () => {
    const agent = new Agent(ctx.app);
    const body = { email: "dup@example.com", password: PASSWORD, name: "Dup" };
    const first = await agent.post("/api/v1/auth/register", body);
    const second = await agent.post("/api/v1/auth/register", { ...body, name: "Attacker" });
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json()); // the IAM's 409 is not revealed
    expect(ctx.iam.users.size).toBe(1);
    expect(ctx.iam.users.get("dup@example.com")?.firstName).toBe("Dup");
  });
});

describe("3. login", () => {
  it("sets an HttpOnly, SameSite=Lax cookie, mirrors the IAM user, and never leaks IAM data", async () => {
    await signUp(ctx, "login@example.com", { name: "Login User" });
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
        maxAge?: number;
      }[]
    ).find((c) => c.name === "dm_session");
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 86_400,
    });
    // The IAM login response contains passwordHash/twoFactorSecret and tokens:
    // none of it may reach the browser.
    expect(res.body).not.toMatch(/passwordHash|twoFactorSecret|accessToken|refreshToken|\$2b\$/);
    expect(res.json<MeResponse>().user).toMatchObject({
      email: "login@example.com",
      name: "Login User",
      role: "USER",
      emailVerified: true,
    });

    const iamUser = ctx.iam.users.get("login@example.com");
    const mirror = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: "login@example.com" },
    });
    expect(mirror.iamUserId).toBe(iamUser?.id);
    const raw = agent.cookie("dm_session") ?? "";
    expect(await ctx.prisma.userSession.count({ where: { tokenHash: sha256(raw) } })).toBe(1);
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("stores IAM tokens encrypted, never in plaintext", async () => {
    const { userId } = await signUp(ctx, "crypto@example.com");
    const session = await ctx.prisma.userSession.findFirstOrThrow({ where: { userId } });
    expect(session.iamAccessTokenEnc).toMatch(/^v1\./);
    expect(session.iamAccessTokenEnc).not.toContain("eyJ"); // no raw JWT
    const cipher = new TokenCipher(TOKEN_KEY);
    expect(cipher.decrypt(session.iamAccessTokenEnc).split(".")).toHaveLength(3);
    expect(session.iamSessionId).not.toBeNull();
  });

  it("uses __Host- prefixed Secure cookies when COOKIE_SECURE=true", async () => {
    const secure = await createTestApp({ COOKIE_SECURE: "true" }, {}, ctx.iam);
    try {
      await signUp(secure, "secure@example.com");
      const res = await new Agent(secure.app).post("/api/v1/auth/login", {
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
    expect(agent.cookie("dm_session")).not.toBe(before);
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
      password: "Wrong-pass-1!",
    });
    const unknown = await agent.post("/api/v1/auth/login", {
      email: "nobody@example.com",
      password: "Wrong-pass-1!",
    });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(errorOf(wrong).message).toBe(errorOf(unknown).message);
    expect(agent.cookie("dm_session")).toBeUndefined();
  });

  it("locks an account after repeated failures without even asking the IAM", async () => {
    await signUp(ctx, "locked@example.com");
    const agent = new Agent(ctx.app);
    for (let i = 0; i < 5; i += 1) {
      await agent.post("/api/v1/auth/login", {
        email: "locked@example.com",
        password: "Wrong-pass-1!",
      });
    }
    const loginsBefore = ctx.iam.callsTo("/auth/login").length;
    const res = await agent.post("/api/v1/auth/login", {
      email: "locked@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(429);
    expect(ctx.iam.callsTo("/auth/login")).toHaveLength(loginsBefore);
  });

  it("rejects a DealMind-suspended user's correct password and ends the IAM session", async () => {
    const { userId } = await signUp(ctx, "suspended@example.com");
    await ctx.prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });
    const logoutsBefore = ctx.iam.callsTo("/auth/logout").length;
    const res = await new Agent(ctx.app).post("/api/v1/auth/login", {
      email: "suspended@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(403);
    expect(ctx.iam.callsTo("/auth/logout").length).toBe(logoutsBefore + 1);
  });
});

describe("5. logout", () => {
  it("revokes the DealMind session and the IAM session, and clears the cookie", async () => {
    const { agent, userId } = await signUp(ctx, "bye@example.com");
    const stolen = agent.cookie("dm_session") ?? "";
    const { iamSessionId } = await ctx.prisma.userSession.findFirstOrThrow({
      where: { userId, revokedAt: null },
    });

    expect((await agent.post("/api/v1/auth/logout")).statusCode).toBe(204);
    expect(agent.cookie("dm_session")).toBeUndefined();
    expect(ctx.iam.sessions.get(iamSessionId ?? "")?.revoked).toBe(true);

    const replay = new Agent(ctx.app);
    replay.jar.set("dm_session", stolen);
    expect((await replay.get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

describe("6. expired and revoked sessions", () => {
  it("rejects sessions past their absolute expiry", async () => {
    const { agent, userId } = await signUp(ctx, "expired@example.com");
    await ctx.prisma.userSession.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1_000), createdAt: new Date(Date.now() - 10_000) },
    });
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(401);
    expect(agent.cookie("dm_session")).toBeUndefined();
  });

  it("rejects sessions idle longer than the idle timeout", async () => {
    const { agent, userId } = await signUp(ctx, "idle@example.com");
    await ctx.prisma.userSession.updateMany({
      where: { userId },
      data: { lastUsedAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(401);
  });

  it("ends the DealMind session once the IAM session is revoked elsewhere", async () => {
    const { agent, userId } = await signUp(ctx, "elsewhere@example.com");
    ctx.iam.revokeAllSessions("elsewhere@example.com");
    // Still valid until the cached IAM access token needs revalidation...
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200);
    await expireIamAccessTokens(ctx.prisma, userId);
    // ...then the refresh fails and the session ends.
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(401);
  });

  it("refreshes IAM tokens transparently and exactly once under concurrency", async () => {
    const { agent, userId } = await signUp(ctx, "refresh@example.com");
    await expireIamAccessTokens(ctx.prisma, userId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => agent.get("/api/v1/auth/me")),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    // A second refresh with the same single-use token would revoke the IAM session.
    expect(ctx.iam.callsTo("/auth/refresh")).toHaveLength(1);
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200);
  });
});

describe("7. email verification", () => {
  it("verifies via the IAM token, reflects it for the signed-in user, and is single-use", async () => {
    const { agent } = await signUp(ctx, "verify@example.com", { verify: false });
    expect((await agent.get("/api/v1/auth/me")).json<MeResponse>().user.emailVerified).toBe(false);

    const first = tokenFromIam(ctx.iam, "verify@example.com", "verify");
    expect((await agent.post("/api/v1/auth/resend-verification")).statusCode).toBe(200);
    const second = tokenFromIam(ctx.iam, "verify@example.com", "verify");
    expect(second).not.toBe(first);
    expect((await agent.post("/api/v1/auth/verify-email", { token: first })).statusCode).toBe(400);

    expect((await agent.post("/api/v1/auth/verify-email", { token: second })).statusCode).toBe(200);
    expect((await agent.get("/api/v1/auth/me")).json<MeResponse>().user.emailVerified).toBe(true);
    const reused = await agent.post("/api/v1/auth/verify-email", { token: second });
    expect(reused.statusCode).toBe(400);
    expect(errorOf(reused).message).toMatch(/invalid or has expired/);
  });
});

describe("8. password reset & change", () => {
  it("does not reveal whether an email exists", async () => {
    await signUp(ctx, "known@example.com");
    const agent = new Agent(ctx.app);
    const known = await agent.post("/api/v1/auth/forgot-password", { email: "known@example.com" });
    const unknown = await agent.post("/api/v1/auth/forgot-password", {
      email: "ghost@example.com",
    });
    expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
    expect(known.json()).toEqual(unknown.json());
    expect(ctx.iam.lastResetToken.has("known@example.com")).toBe(true);
    expect(ctx.iam.lastResetToken.has("ghost@example.com")).toBe(false);
  });

  it("resets the password via the IAM; existing sessions end at IAM revalidation", async () => {
    const { agent: laptop, userId } = await signUp(ctx, "reset@example.com");
    const anon = new Agent(ctx.app);
    await anon.post("/api/v1/auth/forgot-password", { email: "reset@example.com" });
    const token = tokenFromIam(ctx.iam, "reset@example.com", "reset");
    const reset = await anon.post("/api/v1/auth/reset-password", {
      token,
      password: "Brand-new-pass-7!",
    });
    expect(reset.statusCode).toBe(200);
    const again = await anon.post("/api/v1/auth/reset-password", {
      token,
      password: "Another-pass-8!",
    });
    expect(again.statusCode).toBe(400);

    await expireIamAccessTokens(ctx.prisma, userId);
    expect((await laptop.get("/api/v1/auth/me")).statusCode).toBe(401);
    const login = (password: string) =>
      new Agent(ctx.app).post("/api/v1/auth/login", { email: "reset@example.com", password });
    expect((await login(PASSWORD)).statusCode).toBe(401);
    expect((await login("Brand-new-pass-7!")).statusCode).toBe(200);
  });

  it("changes the password, revokes other sessions (and their IAM sessions), rotates this one", async () => {
    const { agent: laptop, userId } = await signUp(ctx, "change@example.com");
    const phone = new Agent(ctx.app);
    await phone.post("/api/v1/auth/login", { email: "change@example.com", password: PASSWORD });
    const phoneRow = await ctx.prisma.userSession.findFirstOrThrow({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const before = laptop.cookie("dm_session");

    const wrong = await laptop.post("/api/v1/auth/change-password", {
      currentPassword: "Not-my-password-1!",
      newPassword: "Changed-pass-99!",
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await laptop.post("/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: "Changed-pass-99!",
    });
    expect(ok.statusCode).toBe(200);
    expect(laptop.cookie("dm_session")).not.toBe(before);
    expect((await laptop.get("/api/v1/auth/me")).statusCode).toBe(200);
    expect((await phone.get("/api/v1/auth/me")).statusCode).toBe(401);
    expect(ctx.iam.sessions.get(phoneRow.iamSessionId ?? "")?.revoked).toBe(true);
  });

  it("treats replay of a rotated-away session token as theft and revokes the family", async () => {
    const { agent } = await signUp(ctx, "theft@example.com");
    const old = agent.cookie("dm_session") ?? "";
    await agent.post("/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: "Changed-pass-99!",
    });
    const attacker = new Agent(ctx.app);
    attacker.jar.set("dm_session", old);
    expect((await attacker.get("/api/v1/auth/me")).statusCode).toBe(401);
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

  it("rejects forged session cookies and never accepts a raw IAM token", async () => {
    const forged = new Agent(ctx.app);
    forged.jar.set("dm_session", "forged-value-that-is-not-a-real-session");
    expect((await forged.get("/api/v1/auth/me")).statusCode).toBe(401);

    const iamToken = await ctx.iam.sign({
      sub: "x",
      email: "x@example.com",
      type: "access",
      sessionId: "s",
    });
    const bearer = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${iamToken}` },
    });
    expect(bearer.statusCode).toBe(401); // browsers authenticate only via the DealMind cookie
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
    const { agent: admin, userId: adminId } = await signUp(ctx, "root@example.com", {
      role: "ADMIN",
    });
    const { agent: user, userId } = await signUp(ctx, "promote@example.com");

    const promote = await admin.patch(`/api/v1/admin/users/${userId}/role`, { role: "ADMIN" });
    expect(promote.statusCode).toBe(200);
    expect((await user.get("/api/v1/auth/me")).statusCode).toBe(401);
    await user.post("/api/v1/auth/login", { email: "promote@example.com", password: PASSWORD });
    expect((await user.get("/api/v1/admin/users")).statusCode).toBe(200);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.user_role_changed" },
    });
    expect(audit.entityId).toBe(userId);
    const self = await admin.patch(`/api/v1/admin/users/${adminId}/role`, { role: "USER" });
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
    expect((await bob.delete(`/api/v1/auth/sessions/${aliceSession.id}`)).statusCode).toBe(404);
    expect((await alice.get("/api/v1/auth/me")).statusCode).toBe(200);
    expect(ctx.iam.sessions.get(aliceSession.iamSessionId ?? "")?.revoked).toBe(false);
  });

  it("profile and preference updates only ever touch the caller", async () => {
    const { agent: alice } = await signUp(ctx, "alice2@example.com", { name: "Alice" });
    const { userId: bobId } = await signUp(ctx, "bob2@example.com", { name: "Bob" });

    const smuggledPrefs = await alice.patch("/api/v1/users/me/preferences", {
      notifyEmail: false,
      userId: bobId,
    });
    expect(smuggledPrefs.statusCode).toBe(422);
    const smuggledName = await alice.patch("/api/v1/users/me", {
      name: "Bob Hacked",
      userId: bobId,
    });
    expect(smuggledName.statusCode).toBe(422);
    expect(
      (await alice.patch("/api/v1/users/me/preferences", { notifyEmail: false })).statusCode,
    ).toBe(200);

    const renamed = await alice.patch("/api/v1/users/me", { name: "Alice Bhatt" });
    expect(renamed.json<MeResponse>().user.name).toBe("Alice Bhatt");
    expect(ctx.iam.users.get("alice2@example.com")).toMatchObject({
      firstName: "Alice",
      lastName: "Bhatt",
    });

    const bob = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: bobId },
      include: { preference: true },
    });
    expect(bob.name).toBe("Bob");
    expect(bob.preference?.notifyEmail).toBe(true);
    expect(ctx.iam.users.get("bob2@example.com")?.firstName).toBe("Bob");
  });
});

describe("12. session revocation", () => {
  it("lists sessions without secrets and revokes another device (and its IAM session)", async () => {
    const { agent: laptop, userId } = await signUp(ctx, "devices@example.com");
    const phone = new Agent(ctx.app);
    await phone.post("/api/v1/auth/login", { email: "devices@example.com", password: PASSWORD });

    const res = await laptop.get("/api/v1/auth/sessions");
    expect(res.body).not.toMatch(/tokenHash|familyId|iam|dm_session/i);
    const { sessions } = res.json<SessionsResponse>();
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current);
    const otherRow = await ctx.prisma.userSession.findUniqueOrThrow({
      where: { id: other?.id ?? "" },
    });

    expect((await laptop.delete(`/api/v1/auth/sessions/${other?.id}`)).statusCode).toBe(204);
    expect((await phone.get("/api/v1/auth/me")).statusCode).toBe(401);
    expect(ctx.iam.sessions.get(otherRow.iamSessionId ?? "")?.revoked).toBe(true);
    expect((await laptop.get("/api/v1/auth/me")).statusCode).toBe(200);
    expect(await ctx.prisma.userSession.count({ where: { userId, revokedAt: null } })).toBe(1);
  });

  it("revoking the current session signs this browser out", async () => {
    const { agent } = await signUp(ctx, "self@example.com");
    const { sessions } = (await agent.get("/api/v1/auth/sessions")).json<SessionsResponse>();
    const current = sessions.find((s) => s.current);
    expect((await agent.delete(`/api/v1/auth/sessions/${current?.id}`)).statusCode).toBe(204);
    expect(agent.cookie("dm_session")).toBeUndefined();
  });

  it("suspending a user revokes all of their DealMind sessions", async () => {
    const { agent: admin } = await signUp(ctx, "mod@example.com", { role: "ADMIN" });
    const { agent: user, userId } = await signUp(ctx, "naughty@example.com");
    await admin.patch(`/api/v1/admin/users/${userId}/status`, { status: "SUSPENDED" });
    expect(await ctx.prisma.userSession.count({ where: { userId, revokedAt: null } })).toBe(0);
    expect((await user.get("/api/v1/auth/me")).statusCode).toBe(401);
  });
});

describe("IAM availability", () => {
  it("returns 503 (not a credential error) when the IAM is down at sign-in", async () => {
    await signUp(ctx, "outage@example.com");
    ctx.iam.down = true;
    const res = await new Agent(ctx.app).post("/api/v1/auth/login", {
      email: "outage@example.com",
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("keeps signed-in users working during an outage and never logs them out because of it", async () => {
    const { agent, userId } = await signUp(ctx, "resilient@example.com");
    ctx.iam.down = true;
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200); // cached IAM token still valid
    await expireIamAccessTokens(ctx.prisma, userId);
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(503); // can't revalidate: 503, not 401
    ctx.iam.down = false;
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200); // session survived
  });

  it("reports IAM health in readiness", async () => {
    const ok = await ctx.app.inject({ method: "GET", url: "/health/ready" });
    expect(ok.json()).toMatchObject({ status: "ok", checks: { iam: "ok", iamJwks: "ok" } });
    ctx.iam.down = true;
    expect((await ctx.app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
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
    expect(forged.statusCode).toBe(403);
    expect((await agent.get("/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("rejects requests from foreign origins even with a valid token", async () => {
    const { agent } = await signUp(ctx, "origin@example.com");
    const evil = new Agent(ctx.app, "https://evil.example");
    for (const [k, v] of agent.jar) evil.jar.set(k, v);
    expect((await evil.post("/api/v1/auth/logout")).statusCode).toBe(403);
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
    const strict = await createTestApp(
      {},
      { rateLimits: undefined, loginThrottle: undefined },
      ctx.iam,
    );
    try {
      const agent = new Agent(strict.app);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const res = await agent.post("/api/v1/auth/login", {
          email: `n${i}@example.com`,
          password: "Whatever-1!",
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
