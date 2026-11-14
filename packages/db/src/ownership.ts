/**
 * Application-level ownership helpers. They complement (not replace) the
 * database guarantees:
 *
 *  1. Every user-owned row has a NOT NULL `userId` foreign key.
 *  2. Child rows reference their parent via composite FKs
 *     (parentId, userId) → parent(id, userId), so cross-user attachment is
 *     rejected by PostgreSQL.
 *
 * Rules for application code:
 *  - Take `userId` ONLY from the authenticated principal, never from input.
 *  - Always include `ownedBy(userId)` in the `where` of user-owned queries,
 *    e.g. `findFirst({ where: { id, ...ownedBy(userId) } })`.
 *  - Report another user's record as NOT FOUND, never as FORBIDDEN, so record
 *    existence is not leaked.
 */
import { Prisma } from "@prisma/client";

export class OwnershipError extends Error {
  override readonly name = "OwnershipError";
  constructor(readonly entity: string) {
    super(`${entity} not found`);
  }
}

/** `where` fragment restricting a query to one user's rows. */
export function ownedBy(userId: string): { userId: string } {
  if (!userId) throw new Error("ownedBy() requires a userId");
  return { userId };
}

/**
 * Returns the record if it exists and belongs to `userId`; otherwise throws
 * OwnershipError (deliberately indistinguishable from "not found").
 */
export function assertOwnedBy<T extends { userId: string | null }>(
  record: T | null | undefined,
  userId: string,
  entity: string,
): T {
  if (!record || record.userId !== userId) throw new OwnershipError(entity);
  return record;
}

/** Composite ownership FKs are named `<Child>_<parentFk>_userId_fkey`. */
const OWNERSHIP_FK = /_[A-Za-z]+Id_userId_fkey/;

/**
 * True when a write failed because a child row referenced a parent owned by a
 * different user (or a parent that does not exist).
 */
export function isOwnershipViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2003") {
    return false;
  }
  // Prisma 6 reports `meta.constraint`; older versions used `meta.field_name`.
  const meta = error.meta as { constraint?: unknown; field_name?: unknown } | undefined;
  const name = meta?.constraint ?? meta?.field_name;
  return typeof name === "string" && OWNERSHIP_FK.test(name);
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}
