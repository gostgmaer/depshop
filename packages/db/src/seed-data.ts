/**
 * Global reference data. Seeding is idempotent and never overwrites values an
 * admin may have changed (plan prices/limits, source status and tuning).
 *
 * Deliberately NOT seeded here: products, variants, offers, prices or users.
 * Real catalog and price data may only come from authorized shopping sources.
 * Illustrative development data lives in `sample-data.ts` (dev-only, labeled).
 */
import { DEFAULT_PLANS } from "@dealmind/shared";
import type { PrismaClient } from "@prisma/client";

export interface CategorySeed {
  slug: string;
  name: string;
  children?: CategorySeed[];
}

export const CATEGORY_TREE: CategorySeed[] = [
  {
    slug: "electronics",
    name: "Electronics",
    children: [
      { slug: "smartphones", name: "Smartphones" },
      { slug: "laptops", name: "Laptops" },
      { slug: "tablets", name: "Tablets" },
      { slug: "televisions", name: "Televisions" },
      { slug: "audio", name: "Headphones & Speakers" },
      { slug: "wearables", name: "Smartwatches & Wearables" },
      { slug: "cameras", name: "Cameras" },
      { slug: "gaming", name: "Gaming" },
      { slug: "computer-accessories", name: "Computer Accessories" },
    ],
  },
  {
    slug: "fashion",
    name: "Fashion",
    children: [
      { slug: "mens-clothing", name: "Men's Clothing" },
      { slug: "womens-clothing", name: "Women's Clothing" },
      { slug: "footwear", name: "Footwear" },
      { slug: "watches", name: "Watches" },
    ],
  },
  {
    slug: "home-kitchen",
    name: "Home and Kitchen",
    children: [
      {
        slug: "home-appliances",
        name: "Home Appliances",
        children: [
          { slug: "refrigerators", name: "Refrigerators" },
          { slug: "washing-machines", name: "Washing Machines" },
          { slug: "air-conditioners", name: "Air Conditioners" },
        ],
      },
      { slug: "kitchen-appliances", name: "Kitchen Appliances" },
      { slug: "furniture", name: "Furniture" },
      { slug: "home-decor", name: "Home Decor" },
    ],
  },
  { slug: "beauty-personal-care", name: "Beauty and Personal Care" },
  { slug: "sports-fitness", name: "Sports and Fitness" },
  { slug: "books", name: "Books" },
  { slug: "grocery", name: "Grocery" },
  { slug: "automotive", name: "Automotive" },
];

/** Slugs renamed since an earlier seed; the row is kept (with its products). */
export const RENAMED_CATEGORY_SLUGS: Record<string, string> = { mobiles: "smartphones" };

export const SHOPPING_SOURCES = [
  {
    slug: "amazon_in",
    name: "Amazon India",
    domain: "amazon.in",
    baseUrl: "https://www.amazon.in",
    integrationKind: "OFFICIAL_API",
  },
  {
    slug: "flipkart",
    name: "Flipkart",
    domain: "flipkart.com",
    baseUrl: "https://www.flipkart.com",
    integrationKind: "AFFILIATE_FEED",
  },
  {
    slug: "croma",
    name: "Croma",
    domain: "croma.com",
    baseUrl: "https://www.croma.com",
    integrationKind: "PARTNER",
  },
  {
    slug: "reliance_digital",
    name: "Reliance Digital",
    domain: "reliancedigital.in",
    baseUrl: "https://www.reliancedigital.in",
    integrationKind: "PARTNER",
  },
  {
    slug: "tata_cliq",
    name: "Tata CLiQ",
    domain: "tatacliq.com",
    baseUrl: "https://www.tatacliq.com",
    integrationKind: "PARTNER",
  },
] as const;

export interface SeedSummary {
  plans: number;
  sources: number;
  categories: number;
}

export function countCategories(nodes: CategorySeed[] = CATEGORY_TREE): number {
  return nodes.reduce((n, c) => n + 1 + countCategories(c.children ?? []), 0);
}

export async function seedReferenceData(prisma: PrismaClient): Promise<SeedSummary> {
  const plans = Object.values(DEFAULT_PLANS);
  for (const plan of plans) {
    await prisma.subscriptionPlan.upsert({
      where: { code: plan.code },
      create: { ...plan, limits: { ...plan.limits } },
      update: {}, // keep admin-edited prices/limits
    });
  }

  for (const source of SHOPPING_SOURCES) {
    await prisma.shoppingSource.upsert({
      where: { slug: source.slug },
      // DISABLED until an authorized integration (credentials) exists.
      create: { ...source, status: "DISABLED" },
      update: { name: source.name, domain: source.domain, baseUrl: source.baseUrl },
    });
  }

  for (const [from, to] of Object.entries(RENAMED_CATEGORY_SLUGS)) {
    const [old, current] = await Promise.all([
      prisma.category.findUnique({ where: { slug: from } }),
      prisma.category.findUnique({ where: { slug: to } }),
    ]);
    if (old && !current)
      await prisma.category.update({ where: { id: old.id }, data: { slug: to } });
  }

  let categories = 0;
  const upsertTree = async (nodes: CategorySeed[], parentId: string | null): Promise<void> => {
    for (const node of nodes) {
      const row = await prisma.category.upsert({
        where: { slug: node.slug },
        create: { slug: node.slug, name: node.name, parentId },
        update: { name: node.name, parentId },
      });
      categories += 1;
      if (node.children) await upsertTree(node.children, row.id);
    }
  };
  await upsertTree(CATEGORY_TREE, null);

  return { plans: plans.length, sources: SHOPPING_SOURCES.length, categories };
}
