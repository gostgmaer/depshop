import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@dealmind/db";
import type { UserRole } from "@dealmind/shared";
import { generateToken, hashToken } from "../../lib/tokens.js";

const DAY_MS = 86_400_000;

export interface ClientInfo {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

/** The authenticated principal, always derived from a verified server-side session. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  role: UserRole;
  emailVerified: boolean;
}

export interface SessionOptions {
  ttlDays: number;
  idleTimeoutDays: number;
  /** Minimum interval between `lastUsedAt` writes (limits write amplification). */
  touchIntervalMs?: number;
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  maxAgeSeconds: number;
}

export class SessionService {
  private readonly ttlMs: number;
  private readonly idleMs: number;
  private readonly touchIntervalMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    opts: SessionOptions,
  ) {
    this.ttlMs = opts.ttlDays * DAY_MS;
    this.idleMs = opts.idleTimeoutDays * DAY_MS;
    this.touchIntervalMs = opts.touchIntervalMs ?? 5 * 60_000;
  }

  get maxAgeSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  async create(
    userId: string,
    client: ClientInfo,
    familyId: string = randomUUID(),
  ): Promise<IssuedSession> {
    const token = generateToken();
    const session = await this.prisma.userSession.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        familyId,
        expiresAt: new Date(Date.now() + this.ttlMs),
        userAgent: truncate(client.userAgent, 512),
        ipAddress: truncate(client.ipAddress, 64),
      },
      select: { id: true },
    });
    return { token, sessionId: session.id, maxAgeSeconds: this.maxAgeSeconds };
  }

  /**
   * Resolves a raw cookie token to an AuthContext, or null if the session is
   * unknown, revoked, expired (absolute or idle) or its user is not ACTIVE.
   */
  async resolve(token: string | undefined): Promise<AuthContext | null> {
    if (!token || token.length > 128) return null;
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        familyId: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        replacedById: true,
        user: { select: { id: true, role: true, status: true, emailVerifiedAt: true } },
      },
    });
    if (!session) return null;

    if (session.revokedAt) {
      // A token that was rotated away is being replayed: assume it was stolen
      // and revoke every session descended from the same login.
      if (session.replacedById) await this.revokeFamily(session.familyId);
      return null;
    }

    const now = Date.now();
    const idleExpired = session.lastUsedAt.getTime() + this.idleMs <= now;
    if (session.expiresAt.getTime() <= now || idleExpired) {
      await this.revoke(session.id);
      return null;
    }
    if (session.user.status !== "ACTIVE") return null;

    if (now - session.lastUsedAt.getTime() >= this.touchIntervalMs) {
      await this.prisma.userSession.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date(now) },
      });
    }

    return {
      sessionId: session.id,
      userId: session.user.id,
      role: session.user.role,
      emailVerified: session.user.emailVerifiedAt !== null,
    };
  }

  /**
   * Replaces a session with a fresh token in the same family (session ID
   * rotation after privilege-relevant events such as a password change).
   */
  async rotate(sessionId: string, userId: string, client: ClientInfo): Promise<IssuedSession> {
    return this.prisma.$transaction(async (tx) => {
      const old = await tx.userSession.findFirst({
        where: { id: sessionId, userId, revokedAt: null },
        select: { familyId: true },
      });
      const token = generateToken();
      const created = await tx.userSession.create({
        data: {
          userId,
          tokenHash: hashToken(token),
          familyId: old?.familyId ?? randomUUID(),
          expiresAt: new Date(Date.now() + this.ttlMs),
          userAgent: truncate(client.userAgent, 512),
          ipAddress: truncate(client.ipAddress, 64),
        },
        select: { id: true },
      });
      await tx.userSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
      return { token, sessionId: created.id, maxAgeSeconds: this.maxAgeSeconds };
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes the session only if it belongs to `userId`. Returns false otherwise. */
  async revokeOwned(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count === 1;
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Active sessions of one user. Token hashes are never selected. */
  listActive(userId: string) {
    const now = new Date();
    return this.prisma.userSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastUsedAt: { gt: new Date(now.getTime() - this.idleMs) },
      },
      orderBy: { lastUsedAt: "desc" },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }
}

function truncate(value: string | undefined, max: number): string | null {
  return value ? value.slice(0, max) : null;
}
