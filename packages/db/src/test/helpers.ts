import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import { resolveTestDatabaseUrl } from "../testing/test-db.js";
export { truncateAll } from "../testing/setup.js";

let client: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  client ??= new PrismaClient({ datasources: { db: { url: resolveTestDatabaseUrl() } } });
  return client;
}

const unique = () => randomUUID().slice(0, 8);

export function createUser(prisma: PrismaClient, data: Partial<Prisma.UserCreateInput> = {}) {
  return prisma.user.create({
    data: {
      email: `user-${unique()}@example.com`,
      name: "Test User",
      iamUserId: randomUUID(),
      ...data,
    },
  });
}

/** Placeholder (not real ciphertext) values for the encrypted IAM token columns. */
export function iamTokenFields() {
  const later = new Date(Date.now() + 86_400_000);
  return {
    iamAccessTokenEnc: "test-ciphertext",
    iamAccessTokenExpiresAt: later,
    iamRefreshTokenEnc: "test-ciphertext",
    iamRefreshTokenExpiresAt: later,
  };
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
