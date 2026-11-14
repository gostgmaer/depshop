/**
 * Seeds reference data only: subscription plans and the shopping-source
 * registry. Sources are seeded DISABLED: a source may only be enabled by an
 * admin after authorized credentials (official API, affiliate feed or partner
 * integration) are configured. No products, prices or offers are seeded.
 */
import { DEFAULT_PLANS } from "@dealmind/shared";
import { createPrismaClient } from "./index.js";

const prisma = createPrismaClient();

const sources = [
  {
    code: "amazon_in",
    name: "Amazon India",
    baseUrl: "https://www.amazon.in",
    integrationKind: "OFFICIAL_API" as const,
  },
  {
    code: "flipkart",
    name: "Flipkart",
    baseUrl: "https://www.flipkart.com",
    integrationKind: "AFFILIATE_FEED" as const,
  },
  {
    code: "croma",
    name: "Croma",
    baseUrl: "https://www.croma.com",
    integrationKind: "PARTNER" as const,
  },
  {
    code: "reliance_digital",
    name: "Reliance Digital",
    baseUrl: "https://www.reliancedigital.in",
    integrationKind: "PARTNER" as const,
  },
  {
    code: "tata_cliq",
    name: "Tata CLiQ",
    baseUrl: "https://www.tatacliq.com",
    integrationKind: "PARTNER" as const,
  },
];

async function main(): Promise<void> {
  const plans = Object.values(DEFAULT_PLANS);
  for (const plan of plans) {
    await prisma.subscriptionPlan.upsert({
      where: { code: plan.code },
      create: { ...plan, limits: { ...plan.limits } },
      // Do not overwrite admin-edited prices/limits on reseed.
      update: {},
    });
  }
  for (const source of sources) {
    await prisma.shoppingSource.upsert({
      where: { code: source.code },
      // Never re-enable or overwrite admin-managed fields on reseed.
      create: { ...source, enabled: false },
      update: { name: source.name, baseUrl: source.baseUrl },
    });
  }
  console.warn(`Seeded ${plans.length} plans and ${sources.length} sources (all disabled).`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
