import type { PrismaClient } from "@dealmind/db";
import { DEFAULT_PLANS, type PublicUser, type UserRole } from "@dealmind/shared";

export type UserStatus = "ACTIVE" | "SUSPENDED";

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface NewSession {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface ListUsersParams {
  limit: number;
  cursor?: string | undefined;
  query?: string | undefined;
}

/**
 * Persistence boundary for users and refresh sessions. A Prisma implementation
 * is used in production; tests use an in-memory implementation.
 */
export interface UserStore {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  /** Creates the user together with a FREE subscription and default preferences. */
  createUser(input: { email: string; name: string; passwordHash: string }): Promise<UserRecord>;
  recordLogin(userId: string): Promise<void>;
  createSession(input: NewSession): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /**
   * Atomically revokes `oldSessionId` (only if still active) and creates its
   * replacement. Returns null if the old session was already revoked, which
   * signals a concurrent or replayed refresh.
   */
  rotateSession(oldSessionId: string, next: NewSession): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<void>;
  revokeSessionFamily(familyId: string): Promise<void>;
  revokeAllUserSessions(userId: string): Promise<void>;
  listUsers(params: ListUsersParams): Promise<{ items: UserRecord[]; nextCursor: string | null }>;
  setUserStatus(userId: string, status: UserStatus): Promise<UserRecord | null>;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

const userSelect = {
  id: true,
  email: true,
  name: true,
  passwordHash: true,
  role: true,
  status: true,
  createdAt: true,
} as const;

const sessionSelect = {
  id: true,
  userId: true,
  tokenHash: true,
  familyId: true,
  expiresAt: true,
  revokedAt: true,
} as const;

export class PrismaUserStore implements UserStore {
  constructor(private readonly prisma: PrismaClient) {}

  findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { email }, select: userSelect });
  }

  findUserById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id }, select: userSelect });
  }

  createUser(input: { email: string; name: string; passwordHash: string }): Promise<UserRecord> {
    const free = DEFAULT_PLANS.FREE;
    return this.prisma.user.create({
      data: {
        ...input,
        preference: { create: {} },
        subscription: {
          create: {
            plan: {
              connectOrCreate: {
                where: { code: free.code },
                create: { ...free, limits: { ...free.limits } },
              },
            },
          },
        },
      },
      select: userSelect,
    });
  }

  async recordLogin(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  }

  createSession(input: NewSession): Promise<SessionRecord> {
    return this.prisma.userSession.create({ data: input, select: sessionSelect });
  }

  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.prisma.userSession.findUnique({ where: { tokenHash }, select: sessionSelect });
  }

  rotateSession(oldSessionId: string, next: NewSession): Promise<SessionRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.userSession.create({ data: next, select: sessionSelect });
      const revoked = await tx.userSession.updateMany({
        where: { id: oldSessionId, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
      if (revoked.count !== 1) {
        await tx.userSession.delete({ where: { id: created.id } });
        return null;
      }
      return created;
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeSessionFamily(familyId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listUsers({ limit, cursor, query }: ListUsersParams) {
    const rows = await this.prisma.user.findMany({
      where: query
        ? {
            OR: [
              { email: { contains: query, mode: "insensitive" } },
              { name: { contains: query, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { id: "asc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: userSelect,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  }

  async setUserStatus(userId: string, status: UserStatus): Promise<UserRecord | null> {
    const result = await this.prisma.user.updateMany({ where: { id: userId }, data: { status } });
    if (result.count === 0) return null;
    return this.findUserById(userId);
  }
}
