import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  REDIS_URL: "redis://127.0.0.1:6379",
  SESSION_SECRET: "x".repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  IAM_BASE_URL: "http://127.0.0.1:3304/api/v1/iam/",
};

describe("loadEnv", () => {
  it("rejects a short session secret and a wrong-size encryption key", () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
    expect(() =>
      loadEnv({ ...base, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("requires the IAM base URL and derives the JWKS URL from it", () => {
    const { IAM_BASE_URL: _omit, ...withoutIam } = base;
    expect(() => loadEnv(withoutIam)).toThrow(/IAM_BASE_URL/);
    const env = loadEnv(base);
    expect(env.IAM_BASE_URL).toBe("http://127.0.0.1:3304/api/v1/iam");
    expect(env.IAM_JWKS_URL).toBe("http://127.0.0.1:3304/api/v1/iam/.well-known/jwks.json");
    expect([env.IAM_TENANT, env.IAM_JWT_ISSUER, env.IAM_JWT_AUDIENCE]).toEqual([
      "easydev",
      "iam-service",
      "easydev",
    ]);
  });

  it("derives allowed origins from APP_URL and CORS_ORIGINS", () => {
    const env = loadEnv({
      ...base,
      APP_URL: "http://localhost:3000/",
      CORS_ORIGINS: "http://a.test, http://b.test",
    });
    expect(env.ALLOWED_ORIGINS).toEqual([
      "http://localhost:3000",
      "http://a.test",
      "http://b.test",
    ]);
  });

  it("defaults secure cookies on only in production, and refuses insecure production", () => {
    expect(loadEnv({ ...base, NODE_ENV: "development" }).COOKIE_SECURE).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: "production" }).COOKIE_SECURE).toBe(true);
    expect(() => loadEnv({ ...base, NODE_ENV: "production", COOKIE_SECURE: "false" })).toThrow(
      /COOKIE_SECURE/,
    );
  });

  it("requires Redis and validates the key prefix", () => {
    const { REDIS_URL: _r, ...withoutRedis } = base;
    expect(() => loadEnv(withoutRedis)).toThrow(/REDIS_URL/);
    expect(loadEnv(base).REDIS_KEY_PREFIX).toBe("dm");
    expect(() => loadEnv({ ...base, REDIS_KEY_PREFIX: "Bad Prefix!" })).toThrow(/REDIS_KEY_PREFIX/);
  });

  it("leaves the notification and file services optional", () => {
    const env = loadEnv(base);
    expect(env.NOTIFICATION_SERVICE_URL).toBeUndefined();
    expect(env.FILE_SERVICE_URL).toBeUndefined();
    expect(env.NOTIFICATION_TENANT_ID).toBe("dealmind");
  });
});

describe("loadEnv: empty variables (Phase 21)", () => {
  it("treats empty strings as unset (compose passes optional settings as '')", () => {
    const env = loadEnv({
      ...base,
      PAYMENT_SERVICE_URL: "",
      PAYMENT_WEBHOOK_SECRET: "",
      NOTIFICATION_TOKEN_SECRET: "",
      VAPID_PUBLIC_KEY: "",
      FILE_SERVICE_URL: "",
      METRICS_TOKEN: "",
      CORS_ORIGINS: "",
    });
    expect(env.PAYMENT_SERVICE_URL).toBeUndefined();
    expect(env.METRICS_TOKEN).toBeUndefined();
  });

  it("still rejects a required secret that is present but empty", () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: "" })).toThrow(/SESSION_SECRET/);
  });
});
