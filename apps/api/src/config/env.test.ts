import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("rejects a short JWT secret", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", JWT_ACCESS_SECRET: "short" }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });
  it("parses CORS origins", () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      JWT_ACCESS_SECRET: "x".repeat(32),
      CORS_ORIGINS: "http://a.test, http://b.test",
    });
    expect(env.CORS_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
  });
});
