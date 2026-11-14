/**
 * End-to-end search processing with MOCK connectors (fictional data):
 * executor → catalog importer → SearchSourceRun + SearchResult.
 */
import { randomUUID } from "node:crypto";
import { CatalogImporter } from "@dealmind/catalog";
import {
  ConnectorError,
  MemoryMetricsStore,
  MemoryRateLimiter,
  MemoryResponseCache,
  ParallelSearchExecutor,
  PrismaSourceConfigProvider,
  ScriptedConnector,
  createDefaultRegistry,
  seedMockSources,
} from "@dealmind/connectors";
import { createPrismaClient, seedReferenceData, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { processShoppingSearch, relevanceScore } from "./search-processor.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
afterAll(() => prisma.$disconnect());

let userId: string;
let deps: Parameters<typeof processShoppingSearch>[0];

beforeEach(async () => {
  await truncateAll(prisma);
  await seedReferenceData(prisma);
  await seedMockSources(prisma, "test");
  await prisma.shoppingSource.create({
    data: {
      slug: "broken_store",
      name: "Broken Store (test)",
      domain: "broken.example.com",
      baseUrl: "https://broken.example.com",
      integrationKind: "PARTNER",
      status: "ACTIVE",
      isSample: true,
      maxRetries: 0,
    },
  });
  userId = (
    await prisma.user.create({
      data: { email: "w@example.com", name: "W", iamUserId: randomUUID() },
    })
  ).id;
  const registry = createDefaultRegistry({ NODE_ENV: "test" }).register(
    new ScriptedConnector("broken_store", "Broken", async () => {
      throw new ConnectorError("UPSTREAM", "503 Service Unavailable", { retryable: false });
    }),
  );
  deps = {
    prisma,
    executor: new ParallelSearchExecutor({
      registry,
      sources: new PrismaSourceConfigProvider(prisma, 0),
      rateLimiter: new MemoryRateLimiter(),
      cache: new MemoryResponseCache(),
      metrics: new MemoryMetricsStore(),
      allowMocks: true,
    }),
    importer: new CatalogImporter(prisma),
  };
});

describe("processShoppingSearch", () => {
  it("searches every eligible source in parallel, stores offers, ranks results and reports each source", async () => {
    const search = await prisma.search.create({ data: { userId, query: "acme nova 5g" } });
    expect(await processShoppingSearch(deps, { searchId: search.id, userId })).toBe("PARTIAL");

    const done = await prisma.search.findUniqueOrThrow({
      where: { id: search.id },
      include: {
        sourceRuns: { include: { source: true } },
        results: { orderBy: { rank: "asc" }, include: { offer: { include: { source: true } } } },
      },
    });
    expect(done.status).toBe("PARTIAL");
    const runs = Object.fromEntries(
      done.sourceRuns.map((r) => [r.source.slug, [r.status, r.errorCode]]),
    );
    expect(runs).toEqual({
      amazon_in: ["SKIPPED", "SOURCE_NOT_ACTIVE"],
      broken_store: ["FAILED", "UPSTREAM"],
      croma: ["SKIPPED", "SOURCE_NOT_ACTIVE"],
      flipkart: ["SKIPPED", "SOURCE_NOT_ACTIVE"],
      mock_alpha: ["SUCCEEDED", null],
      mock_beta: ["SUCCEEDED", null],
      reliance_digital: ["SKIPPED", "SOURCE_NOT_ACTIVE"],
      tata_cliq: ["SKIPPED", "SOURCE_NOT_ACTIVE"],
    });
    // 2 matching fixtures × 2 mock stores; offers stored once in the shared catalog.
    expect(done.results).toHaveLength(4);
    expect(done.results.every((r) => r.offer.source.isSample)).toBe(true);
    expect(done.results.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    const prices = done.results.map((r) => Number(r.pricePaiseAtSearch));
    expect(prices).toEqual([...prices].sort((a, b) => a - b)); // equal relevance → cheapest first
    expect(await prisma.product.count()).toBe(1); // both stores' listings matched one product
    expect(await prisma.productVariant.count()).toBe(2);
    expect(await prisma.priceSnapshot.count()).toBe(4);
  });

  it("applies the user's source and price filters", async () => {
    const search = await prisma.search.create({
      data: {
        userId,
        query: "acme nova",
        filters: { sourceSlugs: ["mock_beta"], maxPricePaise: 1_900_000 },
      },
    });
    expect(await processShoppingSearch(deps, { searchId: search.id, userId })).toBe("COMPLETED");
    const results = await prisma.searchResult.findMany({
      where: { searchId: search.id },
      include: { offer: { include: { source: true } } },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.offer.source.slug).toBe("mock_beta");
    expect(await prisma.searchSourceRun.count({ where: { searchId: search.id } })).toBe(1);
  });

  it("completes with zero results (never invented) when no source is eligible", async () => {
    await prisma.shoppingSource.updateMany({
      where: { status: "ACTIVE" },
      data: { status: "DISABLED" },
    });
    const search = await prisma.search.create({ data: { userId, query: "phone" } });
    expect(await processShoppingSearch(deps, { searchId: search.id, userId })).toBe("NO_SOURCES");
    const done = await prisma.search.findUniqueOrThrow({
      where: { id: search.id },
      include: { results: true },
    });
    expect(done.status).toBe("COMPLETED");
    expect(done.results).toHaveLength(0);
  });

  it("reports FAILED when every searched source fails", async () => {
    const search = await prisma.search.create({
      data: { userId, query: "acme", filters: { sourceSlugs: ["broken_store"] } },
    });
    expect(await processShoppingSearch(deps, { searchId: search.id, userId })).toBe("FAILED");
    expect((await prisma.search.findUniqueOrThrow({ where: { id: search.id } })).status).toBe(
      "FAILED",
    );
  });

  it("is idempotent and enforces ownership", async () => {
    const search = await prisma.search.create({ data: { userId, query: "acme nova" } });
    await processShoppingSearch(deps, { searchId: search.id, userId });
    expect(await processShoppingSearch(deps, { searchId: search.id, userId })).toBe(
      "already-finished",
    );
    const other = await prisma.search.create({ data: { userId, query: "tv" } });
    expect(await processShoppingSearch(deps, { searchId: other.id, userId: randomUUID() })).toBe(
      "missing",
    );
    expect((await prisma.search.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      "PENDING",
    );
    await expect(processShoppingSearch(deps, { searchId: "nope", userId })).rejects.toThrow();
  });

  it("scores relevance deterministically", () => {
    expect(relevanceScore("acme nova 5g", "Acme Nova 7 5G (8GB RAM)")).toBe(10_000);
    expect(relevanceScore("acme nova pro", "Acme Nova 7 5G")).toBe(6_666);
  });
});
