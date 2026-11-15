/**
 * Prepares a dedicated, disposable test database:
 *   1. ensure the *_test database exists;
 *   2. wipe its public schema (safe: resolveTestDatabaseUrl guarantees *_test + local host);
 *   3. apply every migration with `prisma migrate deploy`, exactly as production would.
 * Returns the database URL and exports it as TEST_DATABASE_URL.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { databaseName, maintenanceUrl, resolveTestDatabaseUrl } from "./test-db.js";

export async function setupTestDatabase(): Promise<string> {
  const url = resolveTestDatabaseUrl();
  const name = databaseName(url);

  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl(url) } } });
  try {
    const rows = await admin.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM pg_database WHERE datname = ${name}`;
    // The name comes from a validated URL ending in "_test"; quote it anyway.
    if (rows.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    // Non-Prisma schemas (matching embeddings, agent checkpoints) go too.
    for (const schema of ["matching", "agent_checkpoints"]) {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
  } finally {
    await db.$disconnect();
  }

  // Run Prisma from packages/db (works from src/ and dist/, and from other packages).
  const dbPackageDir = fileURLToPath(new URL("../..", import.meta.url));
  execSync("pnpm exec prisma migrate deploy", {
    cwd: dbPackageDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  process.env.TEST_DATABASE_URL = url;
  return url;
}

/** Empties every table except Prisma's migration history. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const extra = await prisma.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM pg_tables WHERE schemaname = 'matching' AND tablename = 'product_embeddings'`;
  const list = [
    ...tables.map((t) => `"public"."${t.tablename}"`),
    ...(extra.length ? ["matching.product_embeddings"] : []),
  ].join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
