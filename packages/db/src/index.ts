import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";
export * from "./ownership.js";
export { seedReferenceData, CATEGORY_TREE, SHOPPING_SOURCES } from "./seed-data.js";
export type { SeedSummary, CategorySeed } from "./seed-data.js";

export interface CreatePrismaOptions {
  url?: string;
  log?: boolean;
}

export function createPrismaClient(options: CreatePrismaOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.url ? { datasources: { db: { url: options.url } } } : {}),
    log: options.log ? ["query", "warn", "error"] : ["warn", "error"],
  });
}
