/**
 * Live contract test against the REAL shared EasyDev IAM (opt-in):
 *
 *   pnpm --filter @dealmind/api test:contract
 *
 * Verifies that DealMind's IamClient and IamTokenVerifier agree with the
 * running IAM, i.e. that the fake used by the integration tests is faithful.
 * Creates one throwaway account at example.com (a reserved domain that never
 * receives mail). If IAM_CONTRACT_ADMIN_EMAIL/PASSWORD are set, the account is
 * deleted afterwards; otherwise its id is printed for manual cleanup.
 */
import { afterAll, describe, expect, it } from "vitest";
import { IamClient, IamError, splitName } from "../modules/iam/iam-client.js";
import { IamTokenVerifier } from "../modules/iam/iam-token-verifier.js";

const BASE = (process.env.IAM_CONTRACT_BASE_URL ?? "http://127.0.0.1:3304/api/v1/iam").replace(
  /\/+$/,
  "",
);
const client = new IamClient({
  baseUrl: BASE,
  tenant: process.env.IAM_TENANT ?? "easydev",
  timeoutMs: 10_000,
});
const verifier = new IamTokenVerifier({
  jwksUrl: `${BASE}/.well-known/jwks.json`,
  issuer: process.env.IAM_JWT_ISSUER ?? "iam-service",
  audience: process.env.IAM_JWT_AUDIENCE ?? "easydev",
  timeoutMs: 10_000,
});

const email = `dealmind-contract-${Date.now()}@example.com`;
const password = "Contract-Pass-123!";
const newPassword = "Contract-Pass-456!";
let userId: string | undefined;

afterAll(async () => {
  if (!userId) return;
  const adminEmail = process.env.IAM_CONTRACT_ADMIN_EMAIL;
  const adminPassword = process.env.IAM_CONTRACT_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    console.warn(
      `[contract] left test user ${email} (${userId}) in the IAM; set IAM_CONTRACT_ADMIN_* to auto-delete`,
    );
    return;
  }
  const admin = await new IamClient({ baseUrl: BASE, tenant: "easydev", timeoutMs: 10_000 }).login(
    adminEmail,
    adminPassword,
  );
  const res = await fetch(`${BASE}/users/${userId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${admin.accessToken}`, "x-tenant-id": "easydev" },
  });
  console.warn(`[contract] deleted test user ${email}: HTTP ${res.status}`);
  await client.logout(admin.accessToken).catch(() => undefined);
});

describe("shared IAM contract", () => {
  let access = "";
  let refresh = "";

  it("is healthy and serves an envelope-wrapped JWKS the verifier can use", async () => {
    await client.health();
    await verifier.health();
  });

  it("registers (201) and reports duplicates as 409", async () => {
    // Same input shape AuthService passes (splitName output, incl. displayName).
    const res = await client.register({ email, password, ...splitName("DealMind Contract") });
    userId = res.userId;
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    const dup = await client
      .register({ email, password, firstName: "X", lastName: "Y" })
      .catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(IamError);
    expect((dup as IamError).status).toBe(409);
  });

  it("logs in; the access token verifies (iss/aud/RS256) and matches the user", async () => {
    const login = await client.login(email, password);
    access = login.accessToken;
    refresh = login.refreshToken;
    expect(login.user).toMatchObject({
      id: userId,
      email,
      firstName: "DealMind",
      lastName: "Contract",
    });
    expect(JSON.stringify(login.user)).not.toContain("passwordHash");
    const claims = await verifier.verify(access);
    expect(claims.sub).toBe(userId);
    expect(claims.email).toBe(email);
    expect(claims.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(login.accessExpiresIn).toBeGreaterThan(60);
  });

  it("rejects bad credentials with 401", async () => {
    const err = await client.login(email, "Wrong-Pass-999!").catch((e: unknown) => e);
    expect((err as IamError).status).toBe(401);
  });

  it("serves /auth/me and accepts profile updates", async () => {
    expect((await client.me(access)).id).toBe(userId);
    const updated = await client.updateProfile(access, {
      firstName: "Deal",
      lastName: "Mind",
      displayName: "Deal Mind",
    });
    expect(updated).toMatchObject({ firstName: "Deal", lastName: "Mind" });
  });

  it("rotates refresh tokens and revokes the session when an old one is reused", async () => {
    // IAM refresh tokens are JWTs with second-resolution `iat` and no `jti`:
    // tokens issued within the same second are byte-identical, so rotation
    // (and reuse detection) only applies across a second boundary.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const rotated = await client.refresh(refresh);
    expect(rotated.refreshToken).not.toBe(refresh);
    await verifier.verify(rotated.accessToken);
    const reuse = await client.refresh(refresh).catch((e: unknown) => e);
    expect((reuse as IamError).status).toBe(401);
    // What DealMind relies on: once reuse is detected the session can no longer
    // be refreshed, so DealMind's next IAM revalidation ends the session.
    const refreshAfterReuse = await client.refresh(rotated.refreshToken).catch((e: unknown) => e);
    expect((refreshAfterReuse as IamError).status).toBe(401);
    // Known IAM issue (not asserted): reuse detection only marks the session
    // inactive in the database and does not clear its Redis cache entry, so
    // the rotated ACCESS token keeps passing /auth/me until it expires (≤15 min).
    // See docs/SHARED_SERVICES.md, "IAM issues found".
  });

  it("answers forgot-password identically for known and unknown emails", async () => {
    await client.forgotPassword(email);
    await client.forgotPassword(`nobody-${email}`);
  });

  it("rejects invalid verification and reset tokens with 400", async () => {
    expect(
      ((await client.verifyEmail("x".repeat(43)).catch((e: unknown) => e)) as IamError).status,
    ).toBe(400);
    expect(
      (
        (await client
          .resetPassword("x".repeat(43), newPassword)
          .catch((e: unknown) => e)) as IamError
      ).status,
    ).toBe(400);
  });

  it("changes the password, and logout revokes the session", async () => {
    const login = await client.login(email, password);
    await client.changePassword(login.accessToken, password, newPassword);
    const fresh = await client.login(email, newPassword);
    await client.logout(fresh.accessToken);
    expect(((await client.me(fresh.accessToken).catch((e: unknown) => e)) as IamError).status).toBe(
      401,
    );
  });
});
