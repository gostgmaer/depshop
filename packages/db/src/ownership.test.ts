import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { OwnershipError, assertOwnedBy, isOwnershipViolation, ownedBy } from "./ownership.js";
import { resolveTestDatabaseUrl } from "./testing/test-db.js";

describe("ownership helpers", () => {
  it("ownedBy builds a where fragment and rejects empty ids", () => {
    expect(ownedBy("u1")).toEqual({ userId: "u1" });
    expect(() => ownedBy("")).toThrow();
  });

  it("assertOwnedBy returns owned records and hides everything else as not-found", () => {
    const row = { id: "w1", userId: "u1" };
    expect(assertOwnedBy(row, "u1", "Watchlist")).toBe(row);
    expect(() => assertOwnedBy(row, "u2", "Watchlist")).toThrow(OwnershipError);
    expect(() => assertOwnedBy(null, "u1", "Watchlist")).toThrow("Watchlist not found");
    expect(() => assertOwnedBy({ userId: null }, "u1", "Click")).toThrow(OwnershipError);
  });

  it("recognises composite ownership FK violations only", () => {
    const fk = (meta: Record<string, string>) =>
      new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "x", meta });
    // Prisma 6 shape
    expect(isOwnershipViolation(fk({ constraint: "WatchlistItem_watchlistId_userId_fkey" }))).toBe(
      true,
    );
    expect(isOwnershipViolation(fk({ constraint: "WatchlistItem_variantId_fkey" }))).toBe(false);
    // Legacy shape
    expect(
      isOwnershipViolation(fk({ field_name: "SearchResult_searchId_userId_fkey (index)" })),
    ).toBe(true);
    expect(isOwnershipViolation(new Error("x"))).toBe(false);
  });
});

describe("resolveTestDatabaseUrl safety rails", () => {
  it("derives <db>_test from DATABASE_URL", () => {
    const url = resolveTestDatabaseUrl({
      DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/dealmind?schema=public",
    });
    expect(new URL(url).pathname).toBe("/dealmind_test");
  });
  it("refuses non-_test databases and remote hosts", () => {
    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1/dealmind" }),
    ).toThrow(/_test/);
    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgresql://u:p@db.prod.example.com/x_test" }),
    ).toThrow(/non-local/);
  });
});
