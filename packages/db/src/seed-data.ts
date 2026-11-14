/**
 * Global reference data. Seeding is idempotent and never overwrites values an
 * admin may have changed (plan prices/limits, source enablement and tuning).
 *
 * Deliberately NOT seeded: products, variants, offers, prices or users.
 * Catalog and price data may only come from authorized shopping sources.
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
      { slug: "mobiles", name: "Mobile Phones" },
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
    slug: "home-appliances",
    name: "Home Appliances",
    children: [
      { slug: "refrigerators", name: "Refrigerators" },
      { slug: "washing-machines", name: "Washing Machines" },
      { slug: "air-conditioners", name: "Air Conditioners" },
      { slug: "kitchen-appliances", name: "Kitchen Appliances" },
    ],
  },
];

export const SHOPPING_SOURCES = [
  {
    code: "amazon_in",
    name: "Amazon India",
    baseUrl: "https://www.amazon.in",
    integrationKind: "OFFICIAL_API",
  },
  {
    code: "flipkart",
    name: "Flipkart",
    baseUrl: "https://www.flipkart.com",
    integrationKind: "AFFILIATE_FEED",
  },
  { code: "croma", name: "Croma", baseUrl: "https://www.croma.com", integrationKind: "PARTNER" },
  {
    code: "reliance_digital",
    name: "Reliance Digital",
    baseUrl: "https://www.reliancedigital.in",
    integrationKind: "PARTNER",
  },
  {
    code: "tata_cliq",
    name: "Tata CLiQ",
    baseUrl: "https://www.tatacliq.com",
    integrationKind: "PARTNER",
  },
] as const;

export interface SeedSummary {
  plans: number;
  sources: number;
  categories: number;
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
      where: { code: source.code },
      create: { ...source, enabled: false }, // enabled only once real credentials exist
      update: { name: source.name, baseUrl: source.baseUrl },
    });
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
