import { createPrismaClient, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { processShoppingSearch } from "./search-processor.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
afterAll(() => prisma.$disconnect());

let userId: string;
beforeEach(async () => {
  await truncateAll(prisma);
  userId = (
    await prisma.user.create({
      data: { email: "w@example.com", name: "W", iamUserId: randomUUID() },
    })
  ).id;
  for (const [slug, status] of [
    ["active_src", "ACTIVE"],
    ["off_src", "DISABLED"],
  ] as const) {
    await prisma.shoppingSource.create({
      data: {
        slug,
        name: slug,
        domain: `${slug.replace("_", "")}.test`,
        baseUrl: "https://x.test",
        integrationKind: "PARTNER",
        status,
      },
    });
  }
});

describe("processShoppingSearch", () => {
  it("records NO_CONNECTOR runs for active sources and completes with zero results (nothing invented)", async () => {
    const search = await prisma.search.create({ data: { userId, query: "phone" } });
    expect(await processShoppingSearch(prisma, { searchId: search.id, userId })).toBe("completed");
    const done = await prisma.search.findUniqueOrThrow({
      where: { id: search.id },
      include: { sourceRuns: { include: { source: true } }, results: true },
    });
    expect(done.status).toBe("COMPLETED");
    expect(done.completedAt).not.toBeNull();
    expect(done.results).toHaveLength(0);
    expect(done.sourceRuns.map((r) => [r.source.slug, r.status, r.errorCode])).toEqual([
      ["active_src", "SKIPPED", "NO_CONNECTOR"],
    ]);
  });

  it("is idempotent and enforces ownership", async () => {
    const search = await prisma.search.create({ data: { userId, query: "phone" } });
    await processShoppingSearch(prisma, { searchId: search.id, userId });
    expect(await processShoppingSearch(prisma, { searchId: search.id, userId })).toBe(
      "already-finished",
    );
    expect(await prisma.searchSourceRun.count()).toBe(1);
    const other = await prisma.search.create({ data: { userId, query: "tv" } });
    expect(await processShoppingSearch(prisma, { searchId: other.id, userId: randomUUID() })).toBe(
      "missing",
    );
    expect((await prisma.search.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      "PENDING",
    );
    await expect(processShoppingSearch(prisma, { searchId: "nope", userId })).rejects.toThrow();
  });
});
