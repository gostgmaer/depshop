import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

let client: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  client ??= new PrismaClient({ datasources: { db: { url: resolveTestDatabaseUrl() } } });
  return client;
}

/** Empties every table except Prisma's migration history. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

const unique = () => randomUUID().slice(0, 8);

export function createUser(prisma: PrismaClient, data: Partial<Prisma.UserCreateInput> = {}) {
  return prisma.user.create({
    data: {
      email: `user-${unique()}@example.com`,
      name: "Test User",
      passwordHash: "argon2-hash-placeholder",
      ...data,
    },
  });
}

/** Minimal global catalog: one source, product, variant and offer. */
export async function createCatalog(prisma: PrismaClient) {
  const source = await prisma.shoppingSource.create({
    data: {
      code: `src_${unique().replace(/-/g, "")}`,
      name: "Test Source",
      baseUrl: "https://example.test",
      integrationKind: "PARTNER",
    },
  });
  const product = await prisma.product.create({
    data: {
      title: "Acme Phone X 5G",
      brand: "Acme",
      model: "X",
      fingerprint: `acme-x-${unique()}`,
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, variantKey: "color=black|storage=128gb" },
  });
  const offer = await prisma.productOffer.create({
    data: {
      variantId: variant.id,
      sourceId: source.id,
      externalId: `ext-${unique()}`,
      url: "https://example.test/p/1",
      title: "Acme Phone X 5G (Black, 128 GB)",
      pricePaise: 1_999_900,
      mrpPaise: 2_499_900,
    },
  });
  return { source, product, variant, offer };
}

/** Asserts a write was rejected by the named PostgreSQL CHECK constraint. */
export async function expectCheckViolation(op: Promise<unknown>, constraint: string) {
  const error = await op.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected CHECK ${constraint} to reject the write`).toBeDefined();
  expect(String((error as Error).message)).toContain(constraint);
}

/** Asserts a write failed with the given Prisma error code (P2002 unique, P2003 FK). */
export async function expectPrismaCode(op: Promise<unknown>, code: "P2002" | "P2003") {
  const error = await op.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(code);
  return error as Prisma.PrismaClientKnownRequestError;
}
