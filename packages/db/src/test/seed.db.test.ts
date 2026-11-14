import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CATEGORY_TREE, SHOPPING_SOURCES, seedReferenceData } from "../seed-data.js";
import { testPrisma, truncateAll } from "./helpers.js";

const prisma: PrismaClient = testPrisma();
afterAll(() => prisma.$disconnect());
beforeEach(() => truncateAll(prisma));

const categoryCount = CATEGORY_TREE.reduce((n, c) => n + 1 + (c.children?.length ?? 0), 0);

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
      ["FREE", 0],
      ["PRO", 19_900],
      ["BUSINESS", 99_900],
    ]);

    const sources = await prisma.shoppingSource.findMany();
    expect(sources).toHaveLength(5);
    expect(sources.every((s) => !s.enabled)).toBe(true);

    const mobiles = await prisma.category.findUnique({
      where: { slug: "mobiles" },
      include: { parent: true },
    });
    expect(mobiles?.parent?.slug).toBe("electronics");

    // No catalog, price or user data is ever seeded.
    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.productOffer.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });

  it("is idempotent and preserves admin changes", async () => {
    await seedReferenceData(prisma);
    await prisma.shoppingSource.update({
      where: { code: "flipkart" },
      data: { enabled: true, timeoutMs: 5_000 },
    });
    await prisma.subscriptionPlan.update({
      where: { code: "PRO" },
      data: { monthlyPricePaise: 14_900 },
    });

    await seedReferenceData(prisma);

    expect(await prisma.shoppingSource.count()).toBe(5);
    expect(await prisma.category.count()).toBe(categoryCount);
    const flipkart = await prisma.shoppingSource.findUniqueOrThrow({ where: { code: "flipkart" } });
    expect([flipkart.enabled, flipkart.timeoutMs]).toEqual([true, 5_000]);
    const pro = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: "PRO" } });
    expect(pro.monthlyPricePaise).toBe(14_900);
  });
});
