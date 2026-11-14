/**
 * In-memory stand-in for the shared EasyDev IAM, reproducing the behaviour
 * observed on the real service (see docs/AUTH.md, "IAM contract"):
 *  - `{ success, data, message }` envelopes, JWKS wrapped in that envelope;
 *  - RS256 access tokens with iss/aud/sub/sessionId/isEmailVerified claims;
 *  - 201 on register, 409 for duplicates, generic 401 on bad credentials;
 *  - single-use refresh tokens; reusing one revokes the whole session;
 *  - /auth/me rejects revoked sessions;
 *  - the login response leaks `passwordHash` (so tests can prove DealMind
 *    never forwards IAM payloads to browsers).
 *
 * It is exposed as a `fetch` implementation, so tests need no network.
 */
import { randomUUID } from "node:crypto";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";

export const FAKE_IAM_BASE = "http://fake-iam.test/api/v1/iam";

/** Request-body whitelists of the real IAM's DTOs (docs/openapi.json). */
const ALLOWED_BODY_FIELDS: Record<string, string[]> = {
  "POST /auth/register": [
    "email",
    "phone",
    "password",
    "firstName",
    "lastName",
    "inviteToken",
    "captchaToken",
    "appUrl",
  ],
  "POST /auth/login": ["email", "phone", "password", "otp", "loginMethod"],
  "POST /auth/refresh": ["refreshToken"],
  "POST /auth/register/verify": ["token"],
  "POST /auth/register/send-verification": ["email", "appUrl"],
  "POST /auth/password/forgot": ["email", "appUrl"],
  "POST /auth/password/reset": ["token", "newPassword"],
  "POST /auth/password/change": ["currentPassword", "newPassword"],
  "PATCH /profile": ["firstName", "lastName", "displayName", "phone"],
};
const ISSUER = "iam-service";
const AUDIENCE = "easydev";

interface FakeUser {
  id: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  verified: boolean;
}
interface FakeSession {
  id: string;
  userId: string;
  revoked: boolean;
}

export interface FakeIamCall {
  method: string;
  path: string;
  tenant: string | null;
  body: unknown;
}

export class FakeIam {
  readonly users = new Map<string, FakeUser>(); // by email
  readonly sessions = new Map<string, FakeSession>();
  private readonly refreshTokens = new Map<string, { sessionId: string; used: boolean }>();
  private readonly verifyTokens = new Map<string, string>(); // token -> email
  private readonly resetTokens = new Map<string, string>(); // token -> email
  readonly lastVerifyToken = new Map<string, string>(); // email -> token
  readonly lastResetToken = new Map<string, string>(); // email -> token
  /** Full links the IAM would email (email -> URL). */
  readonly lastVerifyLink = new Map<string, string>();
  readonly lastResetLink = new Map<string, string>();
  /** The IAM's global FRONTEND_URL (used when no appUrl is sent). */
  static readonly DEFAULT_FRONTEND_URL = "http://iam-frontend.test";
  /** Registered applications: origin -> stored frontendUrl. */
  private readonly apps = new Map<string, string>();

  /** Registers an application (as an admin would in the IAM database). */
  registerApp(frontendUrl: string): void {
    this.apps.set(new URL(frontendUrl).origin, frontendUrl.replace(/\/+$/, ""));
  }

  /** Mirrors the IAM's resolveFrontendUrl(): registered origins only. */
  private linkBase(appUrl: string | undefined): string | null {
    if (!appUrl) return FakeIam.DEFAULT_FRONTEND_URL;
    try {
      return this.apps.get(new URL(appUrl).origin) ?? null;
    } catch {
      return null;
    }
  }
  readonly calls: FakeIamCall[] = [];
  /** Simulate an outage: every request fails at the network level. */
  down = false;
  accessTtlSeconds = 900;
  private keys!: {
    privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
    jwk: JWK;
  };

  static async create(): Promise<FakeIam> {
    const iam = new FakeIam();
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    iam.keys = {
      privateKey,
      jwk: { ...(await exportJWK(publicKey)), kid: "fake-key-1", alg: "RS256", use: "sig" },
    };
    return iam;
  }

  reset(): void {
    this.users.clear();
    this.sessions.clear();
    this.refreshTokens.clear();
    this.verifyTokens.clear();
    this.resetTokens.clear();
    this.lastVerifyToken.clear();
    this.lastVerifyLink.clear();
    this.lastResetLink.clear();
    this.lastResetToken.clear();
    this.calls.length = 0;
    this.down = false;
    this.accessTtlSeconds = 900;
  }

  callsTo(path: string): FakeIamCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  /** Revokes every IAM session of a user (as the real IAM does on password reset). */
  revokeAllSessions(email: string): void {
    const user = this.users.get(email);
    for (const s of this.sessions.values()) if (s.userId === user?.id) s.revoked = true;
  }

  /** Signs an arbitrary token with the fake IAM's key (for negative tests). */
  sign(
    claims: Record<string, unknown>,
    opts: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "fake-key-1" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? `${this.accessTtlSeconds}s`)
      .sign(this.keys.privateKey);
  }

  private async issue(user: FakeUser, sessionId: string) {
    const accessToken = await this.sign({
      sub: user.id,
      email: user.email,
      tenantSlug: "easydev",
      roles: ["member"],
      sessionId,
      isEmailVerified: user.verified,
      type: "access",
    });
    const refreshToken = randomUUID() + randomUUID();
    this.refreshTokens.set(refreshToken, { sessionId, used: false });
    return {
      accessToken,
      refreshToken,
      accessExpiresIn: this.accessTtlSeconds,
      refreshExpiresIn: 604_800,
    };
  }

  private userBySub(token: string | undefined): { user: FakeUser; session: FakeSession } | null {
    if (!token) return null;
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
      ) as {
        sub: string;
        sessionId: string;
        exp: number;
      };
      const session = this.sessions.get(payload.sessionId);
      const user = [...this.users.values()].find((u) => u.id === payload.sub);
      if (!session || session.revoked || !user || payload.exp * 1000 < Date.now()) return null;
      return { user, session };
    } catch {
      return null;
    }
  }

  private profile(u: FakeUser) {
    return {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      displayName: u.displayName,
      isEmailVerified: u.verified,
    };
  }

  /** `fetch` implementation routed to the fake. */
  readonly fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace("/api/v1/iam", "");
    const headers = new Headers(init?.headers);
    // IamClient always sends JSON strings.
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
    const method = init?.method ?? "GET";
    this.calls.push({ method, path, tenant: headers.get("x-tenant-id"), body });
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "");

    const ok = (data: unknown, status = 200, message = "Success") =>
      Response.json({ success: true, data, message }, { status });
    const fail = (status: number, message: string | string[]) =>
      Response.json({ success: false, statusCode: status, message }, { status });

    // Like the real IAM (class-validator forbidNonWhitelisted): unknown body
    // properties are rejected with 400. Whitelists come from its OpenAPI DTOs.
    const allowed = ALLOWED_BODY_FIELDS[`${method} ${path}`];
    if (allowed) {
      const extra = Object.keys(body).filter((k) => !allowed.includes(k));
      if (extra.length > 0)
        return fail(
          400,
          extra.map((k) => `property ${k} should not exist`),
        );
    }

    switch (`${method} ${path}`) {
      case "GET /.well-known/jwks.json":
        return ok({ keys: [this.keys.jwk] });
      case "GET /health":
        return ok({ status: "ok" });
      case "POST /auth/register": {
        const base = this.linkBase(body.appUrl);
        if (!base) return fail(400, "appUrl is not the URL of a registered application");
        if (this.users.has(body.email ?? "")) return fail(409, "Account already exists");
        const user: FakeUser = {
          id: randomUUID(),
          email: body.email ?? "",
          password: body.password ?? "",
          firstName: body.firstName ?? "",
          lastName: body.lastName ?? "",
          displayName: null,
          verified: false,
        };
        this.users.set(user.email, user);
        const t = randomUUID().replace(/-/g, "") + "a1b2c3d4e5f6";
        this.verifyTokens.set(t, user.email);
        this.lastVerifyToken.set(user.email, t);
        this.lastVerifyLink.set(user.email, `${base}/verify-email?token=${t}`);
        return ok(
          { message: "Registration successful. Please verify your account.", userId: user.id },
          201,
        );
      }
      case "POST /auth/login": {
        const user = this.users.get(body.email ?? "");
        if (!user || user.password !== body.password) return fail(401, "Invalid credentials");
        const session: FakeSession = { id: randomUUID(), userId: user.id, revoked: false };
        this.sessions.set(session.id, session);
        const tokens = await this.issue(user, session.id);
        // The real IAM leaks these fields; DealMind must never forward them.
        return ok({
          ...tokens,
          userId: user.id,
          user: { ...this.profile(user), passwordHash: "$2b$12$leak", twoFactorSecret: null },
        });
      }
      case "POST /auth/refresh": {
        const entry = this.refreshTokens.get(body.refreshToken ?? "");
        if (!entry) return fail(401, "Invalid refresh token");
        const session = this.sessions.get(entry.sessionId);
        if (entry.used) {
          if (session) session.revoked = true;
          return fail(401, "Refresh token reuse detected - session revoked");
        }
        if (!session || session.revoked) return fail(401, "Session has been revoked or expired");
        entry.used = true;
        const user = [...this.users.values()].find((u) => u.id === session.userId) as FakeUser;
        return ok(await this.issue(user, session.id));
      }
      case "GET /auth/me": {
        const who = this.userBySub(bearer);
        return who ? ok(this.profile(who.user)) : fail(401, "Session has been revoked or expired");
      }
      case "POST /auth/logout": {
        const who = this.userBySub(bearer);
        if (!who) return fail(401, "Unauthorized");
        who.session.revoked = true;
        return ok(null, 200, "Logged out successfully");
      }
      case "POST /auth/register/verify": {
        const email = this.verifyTokens.get(body.token ?? "");
        if (!email) return fail(400, "Invalid or expired verification token");
        this.verifyTokens.delete(body.token ?? "");
        (this.users.get(email) as FakeUser).verified = true;
        return ok(null, 200, "Email verified");
      }
      case "POST /auth/register/send-verification": {
        const base = this.linkBase(body.appUrl);
        if (!base) return fail(400, "appUrl is not the URL of a registered application");
        const user = this.users.get(body.email ?? "");
        if (user) {
          for (const [t, e] of this.verifyTokens) if (e === user.email) this.verifyTokens.delete(t);
          const t = randomUUID().replace(/-/g, "") + "f6e5d4c3b2a1";
          this.verifyTokens.set(t, user.email);
          this.lastVerifyToken.set(user.email, t);
          this.lastVerifyLink.set(user.email, `${base}/verify-email?token=${t}`);
        }
        return ok(null, 200, "Verification email sent");
      }
      case "POST /auth/password/forgot": {
        const base = this.linkBase(body.appUrl);
        if (!base) return fail(400, "appUrl is not the URL of a registered application");
        const user = this.users.get(body.email ?? "");
        if (user) {
          const t = randomUUID().replace(/-/g, "") + "0a0b0c0d0e0f";
          this.resetTokens.set(t, user.email);
          this.lastResetToken.set(user.email, t);
          this.lastResetLink.set(user.email, `${base}/reset-password?token=${t}`);
        }
        return ok(null, 200, "If an account exists, a reset link has been sent");
      }
      case "POST /auth/password/reset": {
        const email = this.resetTokens.get(body.token ?? "");
        if (!email) return fail(400, "Invalid or expired reset token");
        this.resetTokens.delete(body.token ?? "");
        (this.users.get(email) as FakeUser).password = body.newPassword ?? "";
        this.revokeAllSessions(email);
        return ok(null, 200, "Password reset successfully");
      }
      case "POST /auth/password/change": {
        const who = this.userBySub(bearer);
        if (!who) return fail(401, "Unauthorized");
        if (who.user.password !== body.currentPassword)
          return fail(400, "Current password is incorrect");
        who.user.password = body.newPassword ?? "";
        return ok(null, 200, "Password changed successfully");
      }
      case "PATCH /profile": {
        const who = this.userBySub(bearer);
        if (!who) return fail(401, "Unauthorized");
        Object.assign(who.user, {
          firstName: body.firstName,
          lastName: body.lastName,
          displayName: body.displayName,
        });
        return ok(this.profile(who.user), 200, "Profile updated successfully");
      }
    }
    const sessionMatch = /^\/sessions\/([0-9a-f-]+)$/.exec(path);
    if (method === "DELETE" && sessionMatch) {
      const who = this.userBySub(bearer);
      const target = this.sessions.get(sessionMatch[1] ?? "");
      if (!who || !target || target.userId !== who.user.id) return fail(404, "Session not found");
      target.revoked = true;
      return ok(null, 200, "Session revoked");
    }
    return fail(404, `Cannot ${method} ${path}`);
  };
}
