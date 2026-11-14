import { describe, expect, it } from "vitest";
import { FAKE_IAM_BASE, FakeIam } from "../../test/fake-iam.js";
import { IamClient, IamError, displayNameOf, splitName } from "./iam-client.js";
import { IamTokenVerifier } from "./iam-token-verifier.js";

async function setup() {
  const iam = await FakeIam.create();
  const client = new IamClient({
    baseUrl: FAKE_IAM_BASE,
    tenant: "easydev",
    timeoutMs: 2_000,
    fetch: iam.fetch,
  });
  const verifier = new IamTokenVerifier({
    jwksUrl: `${FAKE_IAM_BASE}/.well-known/jwks.json`,
    issuer: "iam-service",
    audience: "easydev",
    timeoutMs: 2_000,
    fetch: iam.fetch,
  });
  return { iam, client, verifier };
}

const creds = { password: "P@ssw0rd-123", firstName: "A", lastName: "B" };

describe("IamClient", () => {
  it("returns only the profile fields DealMind needs (never passwordHash)", async () => {
    const { client } = await setup();
    await client.register({ email: "a@example.com", ...creds });
    const login = await client.login("a@example.com", creds.password);
    expect(Object.keys(login.user).sort()).toEqual(
      ["displayName", "email", "firstName", "id", "isEmailVerified", "lastName"].sort(),
    );
    expect(JSON.stringify(login)).not.toContain("passwordHash");
  });

  it("maps IAM error envelopes and outages to IamError", async () => {
    const { client, iam } = await setup();
    await client.register({ email: "d@example.com", ...creds });
    const conflict = await client
      .register({ email: "d@example.com", ...creds })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(IamError);
    expect(conflict).toMatchObject({
      status: 409,
      message: "Account already exists",
      unavailable: false,
    });
    iam.down = true;
    expect(await client.health().catch((e: unknown) => e)).toMatchObject({
      status: 0,
      unavailable: true,
    });
  });

  it("sends the configured tenant on every call", async () => {
    const { client, iam } = await setup();
    await client.forgotPassword("x@example.com");
    await client.health();
    expect(iam.calls.length).toBe(2);
    expect(iam.calls.every((c) => c.tenant === "easydev")).toBe(true);
  });
});

describe("IamTokenVerifier", () => {
  it("verifies IAM tokens using the envelope-wrapped JWKS", async () => {
    const { iam, verifier } = await setup();
    const token = await iam.sign({
      sub: "u1",
      email: "U1@Example.com",
      type: "access",
      sessionId: "s1",
      isEmailVerified: true,
    });
    expect(await verifier.verify(token)).toMatchObject({
      sub: "u1",
      email: "u1@example.com",
      sessionId: "s1",
      isEmailVerified: true,
    });
  });

  it("rejects wrong issuer, wrong audience, expired and non-access tokens", async () => {
    const { iam, verifier } = await setup();
    const claims = { sub: "u1", email: "u1@example.com", type: "access", sessionId: "s1" };
    await expect(verifier.verify(await iam.sign(claims, { issuer: "evil" }))).rejects.toThrow();
    await expect(verifier.verify(await iam.sign(claims, { audience: "other" }))).rejects.toThrow();
    await expect(verifier.verify(await iam.sign(claims, { expiresIn: "-1s" }))).rejects.toThrow();
    await expect(verifier.verify(await iam.sign({ ...claims, type: "refresh" }))).rejects.toThrow(
      /access token/,
    );
  });

  it("rejects tokens signed by a different key", async () => {
    const { verifier } = await setup();
    const impostor = await FakeIam.create();
    const token = await impostor.sign({ sub: "u1", email: "u1@example.com", type: "access" });
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

describe("name helpers", () => {
  it("splits and rebuilds display names", () => {
    expect(splitName("  Asha   Rao Iyer ")).toEqual({
      firstName: "Asha",
      lastName: "Rao Iyer",
      displayName: "Asha Rao Iyer",
    });
    expect(splitName("Mononym")).toEqual({
      firstName: "Mononym",
      lastName: "",
      displayName: "Mononym",
    });
    const base = { id: "1", email: "jo@example.com", isEmailVerified: false };
    expect(displayNameOf({ ...base, firstName: "Jo", lastName: "Kim", displayName: null })).toBe(
      "Jo Kim",
    );
    expect(displayNameOf({ ...base, firstName: null, lastName: null, displayName: null })).toBe(
      "jo",
    );
  });
});
