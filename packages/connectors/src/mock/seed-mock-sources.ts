/**
 * Dev/test only: ShoppingSource rows for the mock connectors (isSample = true,
 * example.com domain). Refuses to run in production.
 */
import type { PrismaClient } from "@dealmind/db";
import { MOCK_SOURCES } from "../default-registry.js";

export async function seedMockSources(
  prisma: PrismaClient,
  env: string | undefined = process.env.NODE_ENV,
) {
  if (env === "production") throw new Error("Refusing to create mock sources in production");
  for (const m of MOCK_SOURCES) {
    await prisma.shoppingSource.upsert({
      where: { slug: m.slug },
      create: {
        slug: m.slug,
        name: m.name,
        domain: "example.com",
        baseUrl: `https://${m.slug.replace(/_/g, "-")}.example.com`,
        integrationKind: "PARTNER",
        status: "ACTIVE",
        isSample: true,
        statusReason: "Mock connector with fictional data for local development and tests.",
        capabilities: { mock: true },
        cacheTtlSeconds: 60,
      },
      update: { isSample: true, name: m.name },
    });
  }
  return MOCK_SOURCES.length;
}
