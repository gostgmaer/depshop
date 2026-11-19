/**
 * Deals feed sync against real PostgreSQL: the mock stores' feeds (fictional, labelled data)
 * go through the real catalog importer. Only ≥ 20% deals are stored, re-running is
 * idempotent (no duplicate products or offers), and a disabled store is never fetched.
 */
import {
  DealFeedRunner,
  MOCK_SOURCES,
  MemoryRateLimiter,
  MockConnector,
  ConnectorRegistry,
  PrismaSourceConfigProvider,
  seedMockSources,
} from "@dealmind/connectors";
import { createPrismaClient, seedReferenceData, type PrismaClient } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { CatalogImporter, MatchingEngine } from "@dealmind/intelligence";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syncDeals } from "../processors/deals-feed.processor.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
const log = { info: () => undefined, warn: () => undefined };
const TWENTY = 2_000;

function deps() {
  const registry = new ConnectorRegistry();
  for (const m of MOCK_SOURCES)
    registry.register(
      new MockConnector({ id: m.slug, name: m.name, priceFactorBp: m.priceFactorBp }),
    );
  return {
    runner: new DealFeedRunner(registry, new PrismaSourceConfigProvider(prisma), {
      allowMocks: true,
      rateLimiter: new MemoryRateLimiter(),
    }),
    importer: new CatalogImporter(prisma, { engine: new MatchingEngine() }),
    minDiscountBp: TWENTY,
    log,
  };
}

beforeAll(async () => {
  await truncateAll(prisma);
  await seedReferenceData(prisma);
  await seedMockSources(prisma, "test");
});
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PriceSnapshot", "ProductOffer", "ProductVariant", "Product", "ProductMatchReview" CASCADE`,
  );
  await prisma.shoppingSource.updateMany({
    where: { slug: { in: MOCK_SOURCES.map((m) => m.slug) } },
    data: { status: "ACTIVE", rateLimitPerMinute: 1_000 },
  });
});

describe("deals feed sync", () => {
  it("stores only discounted products (≥ 20% off MRP), with a price snapshot each", async () => {
    const r = await syncDeals(deps());
    expect(r.imported).toBeGreaterThan(0);
    const offers = await prisma.productOffer.findMany({
      select: {
        sellingPricePaise: true,
        mrpPaise: true,
        sourceId: true,
        _count: { select: { snapshots: true } },
      },
    });
    expect(offers.length).toBe(r.imported);
    for (const o of offers) {
      const discount = Number(((o.mrpPaise! - o.sellingPricePaise) * 10_000n) / o.mrpPaise!);
      expect(discount).toBeGreaterThanOrEqual(TWENTY);
      expect(o._count.snapshots).toBeGreaterThan(0); // price history starts with the first sighting
    }
    // The fictional 15%-off laptop is never stored.
    expect(await prisma.product.count({ where: { name: { contains: "Laptop" } } })).toBe(0);
    // The same product from several mock stores is one product with several offers.
    const products = await prisma.product.count();
    expect(products).toBeLessThan(offers.length);
  });

  it("re-running updates the same rows (no duplicate products or offers)", async () => {
    await syncDeals(deps());
    const first = {
      products: await prisma.product.count(),
      offers: await prisma.productOffer.count(),
    };
    await syncDeals(deps());
    expect({
      products: await prisma.product.count(),
      offers: await prisma.productOffer.count(),
    }).toEqual(first);
  });

  it("never fetches a store that isn't ACTIVE", async () => {
    const [first, ...rest] = MOCK_SOURCES;
    await prisma.shoppingSource.update({
      where: { slug: first!.slug },
      data: { status: "DISABLED" },
    });
    const r = await syncDeals(deps());
    expect(r.sources.find((s) => s.slug === first!.slug)).toMatchObject({
      status: "SKIPPED",
      reason: "SOURCE_NOT_ACTIVE",
    });
    const disabled = await prisma.shoppingSource.findUniqueOrThrow({
      where: { slug: first!.slug },
    });
    expect(await prisma.productOffer.count({ where: { sourceId: disabled.id } })).toBe(0);
    expect(rest.length).toBeGreaterThan(0);
    expect(await prisma.productOffer.count()).toBeGreaterThan(0);
  });
});
