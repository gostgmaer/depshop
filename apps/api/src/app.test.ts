import type { AuthResponse, ErrorResponseBody } from "@dealmind/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { MemoryUserStore } from "./test/memory-user-store.js";

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
  JWT_ACCESS_SECRET: "test-secret-that-is-definitely-long-enough",
  API_DOCS_ENABLED: "false",
});

let app: FastifyInstance;
let store: MemoryUserStore;
let dbHealthy = true;

beforeEach(async () => {
  store = new MemoryUserStore();
  dbHealthy = true;
  app = await buildApp({
    env,
    userStore: store,
    logger: false,
    healthChecks: {
      database: () => (dbHealthy ? Promise.resolve() : Promise.reject(new Error("down"))),
    },
  });
});
afterEach(async () => {
  await app.close();
});

const credentials = { email: "Asha@Example.com", password: "correct-horse-42", name: "Asha" };

async function register(body: object = credentials) {
  const res = await app.inject({ method: "POST", url: "/v1/auth/register", payload: body });
  return { res, body: res.json<AuthResponse & ErrorResponseBody>() };
}

describe("health", () => {
  it("reports liveness", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
  });
  it("reports readiness failures with 503", async () => {
    dbHealthy = false;
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", checks: { database: "fail" } });
  });
});

describe("auth", () => {
  it("registers a user, normalizing email and never exposing the hash", async () => {
    const { res, body } = await register();
    expect(res.statusCode).toBe(201);
    expect(body.user.email).toBe("asha@example.com");
    expect(body.user.role).toBe("USER");
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(body.tokens.refreshToken.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects duplicate registration with 409", async () => {
    await register();
    const { res, body } = await register();
    expect(res.statusCode).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("rejects weak passwords with a validation error", async () => {
    const { res, body } = await register({ ...credentials, password: "short" });
    expect(res.statusCode).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("logs in and rejects bad passwords without revealing which field was wrong", async () => {
    await register();
    const ok = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: credentials.email, password: credentials.password },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: credentials.email, password: "wrong-password-1" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "nobody@example.com", password: "wrong-password-1" },
    });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json<ErrorResponseBody>().error.message).toBe(
      unknown.json<ErrorResponseBody>().error.message,
    );
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const { body } = await register();
    const first = body.tokens.refreshToken;

    const rotated = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: first },
    });
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json<AuthResponse>().tokens.refreshToken;
    expect(second).not.toBe(first);

    // Replaying the old token is treated as theft: the whole family is revoked.
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: first },
    });
    expect(replay.statusCode).toBe(401);

    const afterReplay = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: second },
    });
    expect(afterReplay.statusCode).toBe(401);
  });

  it("prevents suspended users from logging in", async () => {
    const { body } = await register();
    await store.setUserStatus(body.user.id, "SUSPENDED");
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: credentials.email, password: credentials.password },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("authorization", () => {
  it("requires a valid bearer token for /me", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/users/me" })).statusCode).toBe(401);
    const forged = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("returns the caller's own profile", async () => {
    const { body } = await register();
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string }>().id).toBe(body.user.id);
  });

  it("forbids non-admins from admin routes", async () => {
    const { body } = await register();
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets admins list users and suspend others, revoking their sessions", async () => {
    const { body: victim } = await register();
    const { body: admin } = await register({
      email: "admin@example.com",
      password: "admin-password-1",
      name: "Admin",
    });
    const adminRecord = store.users.get(admin.user.id);
    if (!adminRecord) throw new Error("admin missing");
    adminRecord.role = "ADMIN";
    // Role is embedded in the access token, so log in again to pick it up.
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    const headers = { authorization: `Bearer ${login.json<AuthResponse>().tokens.accessToken}` };

    const list = await app.inject({ method: "GET", url: "/v1/admin/users", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(2);

    const suspend = await app.inject({
      method: "PATCH",
      url: `/v1/admin/users/${victim.user.id}/status`,
      headers,
      payload: { status: "SUSPENDED" },
    });
    expect(suspend.statusCode).toBe(200);

    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: victim.tokens.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    const self = await app.inject({
      method: "PATCH",
      url: `/v1/admin/users/${admin.user.id}/status`,
      headers,
      payload: { status: "SUSPENDED" },
    });
    expect(self.statusCode).toBe(403);

    // Malformed ids are rejected at the edge, before reaching the database.
    const malformed = await app.inject({
      method: "PATCH",
      url: "/v1/admin/users/not-a-uuid/status",
      headers,
      payload: { status: "SUSPENDED" },
    });
    expect(malformed.statusCode).toBe(422);
  });
});

describe("errors", () => {
  it("returns the standard envelope for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorResponseBody>().error.code).toBe("NOT_FOUND");
    expect(res.json<ErrorResponseBody>().error.requestId).toBeTruthy();
  });
});
