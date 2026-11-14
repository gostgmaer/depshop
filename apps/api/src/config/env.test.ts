import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  SESSION_SECRET: "x".repeat(32),
};

describe("loadEnv", () => {
  it("rejects a short session secret", () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
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

  it("defaults secure cookies on only in production", () => {
    expect(loadEnv({ ...base, NODE_ENV: "development" }).COOKIE_SECURE).toBe(false);
    expect(
      loadEnv({ ...base, NODE_ENV: "production", EMAIL_TRANSPORT: "smtp", SMTP_HOST: "smtp.test" })
        .COOKIE_SECURE,
    ).toBe(true);
  });

  it("refuses unsafe production settings", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production" })).toThrow(/EMAIL_TRANSPORT/);
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: "production",
        EMAIL_TRANSPORT: "smtp",
        SMTP_HOST: "smtp.test",
        COOKIE_SECURE: "false",
      }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it("requires SMTP_HOST for the smtp transport", () => {
    expect(() => loadEnv({ ...base, EMAIL_TRANSPORT: "smtp" })).toThrow(/SMTP_HOST/);
  });
});
