/**
 * Vitest global setup for DB integration tests:
 *   1. ensure the dedicated *_test database exists;
 *   2. wipe its public schema (safe: resolveTestDatabaseUrl guarantees *_test + local);
 *   3. apply every migration with `prisma migrate deploy`, exactly as production would.
 */
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { databaseName, maintenanceUrl, resolveTestDatabaseUrl } from "./test-db.js";

export default async function setup(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  const name = databaseName(url);

  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl(url) } } });
  try {
    const rows = await admin.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM pg_database WHERE datname = ${name}`;
    // Identifier comes from a validated URL ending in "_test"; quote it anyway.
    if (rows.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.$executeRawUnsafe("CREATE SCHEMA public");
  } finally {
    await db.$disconnect();
  }

  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  process.env.TEST_DATABASE_URL = url;
}
