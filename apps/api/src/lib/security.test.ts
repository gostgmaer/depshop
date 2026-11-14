import { describe, expect, it } from "vitest";
import { cookieNames, csrfCookieOptions, sessionCookieOptions } from "./cookies.js";
import { CsrfTokens } from "./csrf.js";
import { MemoryLoginThrottle } from "./login-throttle.js";
import { generateToken, hashToken } from "./tokens.js";

describe("tokens", () => {
  it("generates 256-bit url-safe tokens and stable SHA-256 hashes", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
  });
});

describe("CSRF tokens", () => {
  const csrf = new CsrfTokens("s".repeat(32));
  it("accepts a matching, correctly signed token", () => {
    const t = csrf.issue();
    expect(csrf.verify(t, t)).toBe(true);
  });
  it("rejects mismatches, missing values, forgeries and other secrets", () => {
    const t = csrf.issue();
    expect(csrf.verify(t, csrf.issue())).toBe(false);
    expect(csrf.verify(undefined, t)).toBe(false);
    expect(csrf.verify(t, undefined)).toBe(false);
    expect(csrf.verify("abc.def", "abc.def")).toBe(false);
    expect(csrf.verify(`${t}.x`, `${t}.x`)).toBe(false);
    const other = new CsrfTokens("o".repeat(32)).issue();
    expect(csrf.verify(other, other)).toBe(false);
  });
});

describe("cookies", () => {
  it("uses __Host- names only with Secure, and HttpOnly only for the session", () => {
    expect(cookieNames(true).session).toBe("__Host-dm_session");
    expect(cookieNames(false).session).toBe("dm_session");
    expect(sessionCookieOptions(true, 60)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(csrfCookieOptions(false)).toMatchObject({ httpOnly: false, sameSite: "strict" });
  });
});

describe("MemoryLoginThrottle", () => {
  it("locks after N failures within the window and unlocks after the lock period", async () => {
    let now = 0;
    const t = new MemoryLoginThrottle(
      { maxFailures: 3, windowMs: 1_000, lockMs: 5_000 },
      () => now,
    );
    await t.recordFailure("a");
    await t.recordFailure("a");
    expect(await t.isLocked("a")).toBe(false);
    await t.recordFailure("a");
    expect(await t.isLocked("a")).toBe(true);
    expect(await t.isLocked("b")).toBe(false);
    now = 5_001;
    expect(await t.isLocked("a")).toBe(false);
  });
  it("forgets failures outside the window and after success", async () => {
    let now = 0;
    const t = new MemoryLoginThrottle(
      { maxFailures: 2, windowMs: 1_000, lockMs: 5_000 },
      () => now,
    );
    await t.recordFailure("a");
    now = 2_000;
    await t.recordFailure("a");
    expect(await t.isLocked("a")).toBe(false);
    await t.recordSuccess("a");
    await t.recordFailure("a");
    expect(await t.isLocked("a")).toBe(false);
  });
});
