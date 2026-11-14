import { createPrismaClient, type PrismaClient, seedReferenceData } from "@dealmind/db";
import { resolveTestDatabaseUrl, truncateAll } from "@dealmind/db/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SAMPLE_SOURCE, sampleListings, seedSampleCatalog } from "../sample-data.js";

const prisma: PrismaClient = createPrismaClient({ url: resolveTestDatabaseUrl() });
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  await truncateAll(prisma);
  await seedReferenceData(prisma);
});

describe("sample catalog seed (development only)", () => {
  it("imports every sample listing through the importer, grouped into products and variants", async () => {
    const summary = await seedSampleCatalog(prisma, { env: "development" });
    const listings = sampleListings();
    expect(summary).toMatchObject({
      received: listings.length,
      imported: listings.length,
      rejected: 0,
      sentToReview: 0,
    });
    expect(await prisma.product.count()).toBe(7);
    expect(await prisma.productVariant.count()).toBe(listings.length);
    const iphone = await prisma.product.findFirstOrThrow({
      where: { name: "Apple iPhone 15" },
      include: { variants: true, category: true },
    });
    expect(iphone.category?.slug).toBe("smartphones");
    expect(iphone.variants.map((v) => v.variantKey).sort()).toEqual([
      "color=black|storage_gb=128",
      "color=blue|storage_gb=256",
      "color=pink|storage_gb=512",
    ]);
  });

  it("labels everything as sample data and invents no identifiers or specifications", async () => {
    await seedSampleCatalog(prisma, { env: "development" });
    const offers = await prisma.productOffer.findMany({ include: { source: true } });
    expect(offers.every((o) => o.source.isSample && o.source.slug === SAMPLE_SOURCE.slug)).toBe(
      true,
    );
    expect(offers.every((o) => new URL(o.productUrl).hostname.endsWith("example.com"))).toBe(true);
    const products = await prisma.product.findMany();
    for (const p of products) {
      expect([p.gtin, p.ean, p.upc, p.modelNumber, p.launchDate]).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(p.specifications).toEqual({});
    }
    // The real marketplace sources stay disabled.
    expect(
      await prisma.shoppingSource.count({ where: { isSample: false, status: "ACTIVE" } }),
    ).toBe(0);
  });

  it("is idempotent", async () => {
    await seedSampleCatalog(prisma, { env: "development" });
    const again = await seedSampleCatalog(prisma, { env: "development" });
    expect(again).toMatchObject({
      productsCreated: 0,
      offersCreated: 0,
      offersUpdated: sampleListings().length,
    });
    expect(await prisma.product.count()).toBe(7);
  });

  it("refuses to run in production", async () => {
    await expect(seedSampleCatalog(prisma, { env: "production" })).rejects.toThrow(/production/);
    expect(await prisma.shoppingSource.count({ where: { isSample: true } })).toBe(0);
  });
});
