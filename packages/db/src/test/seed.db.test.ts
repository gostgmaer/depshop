import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SHOPPING_SOURCES, countCategories, seedReferenceData } from "../seed-data.js";
import { testPrisma, truncateAll } from "./helpers.js";

const prisma: PrismaClient = testPrisma();
afterAll(() => prisma.$disconnect());
beforeEach(() => truncateAll(prisma));

const categoryCount = countCategories();

describe("seedReferenceData", () => {
  it("seeds plans, disabled sources and the category tree, and nothing else", async () => {
    const summary = await seedReferenceData(prisma);
    expect(summary).toEqual({
      plans: 3,
      sources: SHOPPING_SOURCES.length,
      categories: categoryCount,
    });

    const plans = await prisma.subscriptionPlan.findMany({ orderBy: { monthlyPricePaise: "asc" } });
    expect(plans.map((p) => [p.code, p.monthlyPricePaise])).toEqual([
      ["FREE", 0n],
      ["PRO", 19_900n],
      ["BUSINESS", 99_900n],
    ]);

    const sources = await prisma.shoppingSource.findMany();
    expect(sources).toHaveLength(5);
    // Nothing is ACTIVE: every marketplace awaits credentials or approval.
    expect(sources.every((s) => s.status !== "ACTIVE" && !s.isSample && s.statusReason)).toBe(true);
    expect(Object.fromEntries(sources.map((s) => [s.slug, s.status]))).toEqual({
      amazon_in: "PENDING_APPROVAL",
      flipkart: "PENDING_CREDENTIALS",
      croma: "PENDING_APPROVAL",
      reliance_digital: "PENDING_APPROVAL",
      tata_cliq: "PENDING_APPROVAL",
    });

    const phones = await prisma.category.findUnique({
      where: { slug: "smartphones" },
      include: { parent: true },
    });
    expect(phones?.parent?.slug).toBe("electronics");
    const fridges = await prisma.category.findUnique({
      where: { slug: "refrigerators" },
      include: { parent: { include: { parent: true } } },
    });
    expect(fridges?.parent?.parent?.slug).toBe("home-kitchen");
    for (const slug of [
      "fashion",
      "mens-clothing",
      "womens-clothing",
      "beauty-personal-care",
      "sports-fitness",
      "books",
      "grocery",
      "automotive",
    ]) {
      expect(await prisma.category.findUnique({ where: { slug } }), slug).not.toBeNull();
    }

    // No catalog, price or user data is ever seeded.
    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.productOffer.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });

  it("is idempotent and preserves admin changes", async () => {
    await seedReferenceData(prisma);
    await prisma.shoppingSource.update({
      where: { slug: "flipkart" },
      data: { status: "MAINTENANCE", timeoutMs: 5_000 },
    });
    await prisma.subscriptionPlan.update({
      where: { code: "PRO" },
      data: { monthlyPricePaise: 14_900n },
    });

    await seedReferenceData(prisma);

    expect(await prisma.shoppingSource.count()).toBe(5);
    expect(await prisma.category.count()).toBe(categoryCount);
    const flipkart = await prisma.shoppingSource.findUniqueOrThrow({ where: { slug: "flipkart" } });
    expect([flipkart.status, flipkart.timeoutMs]).toEqual(["MAINTENANCE", 5_000]);
    const pro = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: "PRO" } });
    expect(pro.monthlyPricePaise).toBe(14_900n);
  });

  it("renames a legacy category slug in place, keeping its products", async () => {
    const legacy = await prisma.category.create({
      data: { slug: "mobiles", name: "Mobile Phones" },
    });
    await prisma.product.create({
      data: { name: "P", normalizedName: "p", brand: "B", categoryId: legacy.id },
    });
    await seedReferenceData(prisma);
    const phones = await prisma.category.findUniqueOrThrow({
      where: { slug: "smartphones" },
      include: { products: true },
    });
    expect(phones.id).toBe(legacy.id);
    expect(phones.products).toHaveLength(1);
    expect(await prisma.category.findUnique({ where: { slug: "mobiles" } })).toBeNull();
  });

  it("upgrades an untouched legacy DISABLED source to its researched status, keeps admin choices", async () => {
    await prisma.shoppingSource.create({
      data: {
        slug: "croma",
        name: "Croma",
        domain: "croma.com",
        baseUrl: "https://www.croma.com",
        integrationKind: "PARTNER",
        status: "DISABLED",
      },
    });
    await prisma.shoppingSource.create({
      data: {
        slug: "flipkart",
        name: "Flipkart",
        domain: "flipkart.com",
        baseUrl: "https://www.flipkart.com",
        integrationKind: "AFFILIATE_FEED",
        status: "ACTIVE",
      },
    });
    await seedReferenceData(prisma);
    const rows = await prisma.shoppingSource.findMany({
      where: { slug: { in: ["croma", "flipkart"] } },
    });
    expect(Object.fromEntries(rows.map((r) => [r.slug, r.status]))).toEqual({
      croma: "PENDING_APPROVAL",
      flipkart: "ACTIVE",
    });
  });
});
