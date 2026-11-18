/**
 * DealMind browser sessions (BFF pattern).
 *
 * The browser holds only an opaque DealMind session cookie (hash stored in
 * `UserSession`). Each session also holds the user's IAM access/refresh
 * tokens, AES-256-GCM encrypted. IAM tokens never reach the browser.
 *
 * IAM refresh tokens are single-use: the IAM revokes the whole session if an
 * old refresh token is presented again. Refreshes are therefore serialized per
 * session, both in-process (promise map) and across API instances
 * (SELECT ... FOR UPDATE on the session row).
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@dealmind/db";
import { AppError, ErrorCode, type UserRole } from "@dealmind/shared";
import type { TokenCipher } from "../../lib/token-cipher.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import { type IamClient, IamError, type IamTokenSet } from "../iam/iam-client.js";
import type { IamClaims, IamTokenVerifier } from "../iam/iam-token-verifier.js";

const DAY_MS = 86_400_000;
/** Refresh IAM access tokens this long before they expire. */
const REFRESH_SKEW_MS = 60_000;

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
  /** A visitor without an account (guest cookie). Only search routes accept guests. */
  guest?: boolean;
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

/** IAM tokens plus their verified claims, ready to be stored. */
export interface IamSessionTokens {
  tokens: IamTokenSet;
  claims: IamClaims;
}

export class SessionService {
  private readonly ttlMs: number;
  private readonly idleMs: number;
  private readonly touchIntervalMs: number;
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: TokenCipher,
    private readonly iam: IamClient,
    private readonly verifier: IamTokenVerifier,
    opts: SessionOptions,
  ) {
    this.ttlMs = opts.ttlDays * DAY_MS;
    this.idleMs = opts.idleTimeoutDays * DAY_MS;
    this.touchIntervalMs = opts.touchIntervalMs ?? 5 * 60_000;
  }

  get maxAgeSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  private iamColumns({ tokens, claims }: IamSessionTokens) {
    const now = Date.now();
    return {
      iamSessionId: claims.sessionId,
      iamAccessTokenEnc: this.cipher.encrypt(tokens.accessToken),
      iamAccessTokenExpiresAt: new Date(now + tokens.accessExpiresIn * 1000),
      iamRefreshTokenEnc: this.cipher.encrypt(tokens.refreshToken),
      iamRefreshTokenExpiresAt: new Date(now + tokens.refreshExpiresIn * 1000),
    };
  }

  async create(userId: string, client: ClientInfo, iam: IamSessionTokens): Promise<IssuedSession> {
    const token = generateToken();
    const session = await this.prisma.userSession.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + this.ttlMs),
        userAgent: truncate(client.userAgent, 512),
        ipAddress: truncate(client.ipAddress, 64),
        ...this.iamColumns(iam),
      },
      select: { id: true },
    });
    return { token, sessionId: session.id, maxAgeSeconds: this.maxAgeSeconds };
  }

  /**
   * Resolves a raw cookie token to an AuthContext, or null if the session is
   * unknown, revoked, expired (absolute or idle), its user is not ACTIVE, or
   * its IAM session has been revoked (checked whenever the cached IAM access
   * token has expired, i.e. at most every ~15 minutes per session).
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
        iamAccessTokenExpiresAt: true,
        user: { select: { id: true, role: true, status: true, emailVerifiedAt: true } },
      },
    });
    if (!session) return null;

    if (session.revokedAt) {
      // A token that was rotated away is being replayed: assume it was stolen.
      if (session.replacedById) await this.revokeFamily(session.familyId);
      return null;
    }

    const now = Date.now();
    if (session.expiresAt.getTime() <= now || session.lastUsedAt.getTime() + this.idleMs <= now) {
      await this.revoke(session.id);
      return null;
    }
    if (session.user.status !== "ACTIVE") return null;

    let emailVerified = session.user.emailVerifiedAt !== null;
    if (session.iamAccessTokenExpiresAt.getTime() - REFRESH_SKEW_MS <= now) {
      // Re-validates the IAM session; fails if it was revoked in the IAM
      // (e.g. password reset or sign-out elsewhere).
      try {
        await this.getIamAccessToken(session.id);
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.UNAUTHENTICATED) return null;
        throw err;
      }
      const user = await this.prisma.user.findUnique({
        where: { id: session.user.id },
        select: { emailVerifiedAt: true },
      });
      emailVerified = !!user?.emailVerifiedAt;
    }

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
      emailVerified,
    };
  }

  /**
   * Returns a valid IAM access token for a session, refreshing it if needed.
   * Throws UNAUTHENTICATED (and revokes the DealMind session) if the IAM
   * session is gone; DEPENDENCY_UNAVAILABLE if the IAM is unreachable.
   */
  async getIamAccessToken(sessionId: string): Promise<string> {
    const row = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, iamAccessTokenEnc: true, iamAccessTokenExpiresAt: true },
    });
    if (!row || row.revokedAt) throw AppError.unauthenticated();
    if (row.iamAccessTokenExpiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
      return this.cipher.decrypt(row.iamAccessTokenEnc);
    }
    let pending = this.refreshes.get(sessionId);
    if (!pending) {
      pending = this.refreshLocked(sessionId).finally(() => this.refreshes.delete(sessionId));
      this.refreshes.set(sessionId, pending);
    }
    return pending;
  }

  private async refreshLocked(sessionId: string): Promise<string> {
    type Outcome =
      { ok: true; accessToken: string } | { ok: false; reason: "revoked" | "unavailable" };
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<Outcome> => {
        const rows = await tx.$queryRaw<
          {
            revokedAt: Date | null;
            userId: string;
            iamAccessTokenEnc: string;
            iamAccessTokenExpiresAt: Date;
            iamRefreshTokenEnc: string;
            iamRefreshTokenExpiresAt: Date;
          }[]
        >`SELECT "revokedAt", "userId", "iamAccessTokenEnc", "iamAccessTokenExpiresAt",
                 "iamRefreshTokenEnc", "iamRefreshTokenExpiresAt"
          FROM "UserSession" WHERE id = ${sessionId}::uuid FOR UPDATE`;
        const row = rows[0];
        if (!row || row.revokedAt) return { ok: false, reason: "revoked" };
        const now = Date.now();
        // Another request or instance refreshed while we waited for the lock.
        if (row.iamAccessTokenExpiresAt.getTime() - REFRESH_SKEW_MS > now) {
          return { ok: true, accessToken: this.cipher.decrypt(row.iamAccessTokenEnc) };
        }
        if (row.iamRefreshTokenExpiresAt.getTime() <= now) return { ok: false, reason: "revoked" };

        let tokens: IamTokenSet;
        let claims: IamClaims;
        try {
          tokens = await this.iam.refresh(this.cipher.decrypt(row.iamRefreshTokenEnc));
          claims = await this.verifier.verify(tokens.accessToken);
        } catch (err) {
          if (err instanceof IamError && err.unavailable)
            return { ok: false, reason: "unavailable" };
          return { ok: false, reason: "revoked" };
        }
        await tx.userSession.update({
          where: { id: sessionId },
          data: this.iamColumns({ tokens, claims }),
        });
        if (claims.isEmailVerified) {
          await tx.user.updateMany({
            where: { id: row.userId, emailVerifiedAt: null },
            data: { emailVerifiedAt: new Date() },
          });
        }
        return { ok: true, accessToken: tokens.accessToken };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    if (outcome.ok) return outcome.accessToken;
    if (outcome.reason === "unavailable") {
      throw new AppError(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        "The identity service is temporarily unavailable",
      );
    }
    await this.revoke(sessionId);
    throw AppError.unauthenticated("Your session has ended. Please sign in again.");
  }

  /** Replaces a session's cookie token (same IAM tokens, same family). */
  async rotate(sessionId: string, userId: string, client: ClientInfo): Promise<IssuedSession> {
    return this.prisma.$transaction(async (tx) => {
      const old = await tx.userSession.findFirst({
        where: { id: sessionId, userId, revokedAt: null },
        select: {
          familyId: true,
          iamSessionId: true,
          iamAccessTokenEnc: true,
          iamAccessTokenExpiresAt: true,
          iamRefreshTokenEnc: true,
          iamRefreshTokenExpiresAt: true,
        },
      });
      if (!old) throw AppError.unauthenticated();
      const { familyId, ...iam } = old;
      const token = generateToken();
      const created = await tx.userSession.create({
        data: {
          userId,
          tokenHash: hashToken(token),
          familyId,
          expiresAt: new Date(Date.now() + this.ttlMs),
          userAgent: truncate(client.userAgent, 512),
          ipAddress: truncate(client.ipAddress, 64),
          ...iam,
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

  /** Revokes the session only if it belongs to `userId`; returns its IAM session id. */
  async revokeOwned(
    userId: string,
    sessionId: string,
  ): Promise<{ revoked: boolean; iamSessionId: string | null }> {
    const session = await this.prisma.userSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
      select: { iamSessionId: true },
    });
    if (!session) return { revoked: false, iamSessionId: null };
    await this.revoke(sessionId);
    return { revoked: true, iamSessionId: session.iamSessionId };
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes a user's sessions; returns the IAM session ids that were attached. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<string[]> {
    const where = {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    };
    const sessions = await this.prisma.userSession.findMany({
      where,
      select: { iamSessionId: true },
    });
    await this.prisma.userSession.updateMany({ where, data: { revokedAt: new Date() } });
    return sessions.map((s) => s.iamSessionId).filter((id): id is string => id !== null);
  }

  /** Active sessions of one user. Token material is never selected. */
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
