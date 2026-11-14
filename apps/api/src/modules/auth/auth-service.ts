import { randomUUID } from "node:crypto";
import {
  AppError,
  type AuthResponse,
  type AuthTokens,
  type LoginInput,
  type RegisterInput,
} from "@dealmind/shared";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../lib/password.js";
import { type TokenService, generateRefreshToken, hashToken } from "../../lib/tokens.js";
import { type UserRecord, type UserStore, toPublicUser } from "../users/user-store.js";

export interface ClientInfo {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

const DAY_MS = 86_400_000;

export class AuthService {
  constructor(
    private readonly store: UserStore,
    private readonly tokens: TokenService,
    private readonly refreshTtlDays: number,
  ) {}

  async register(input: RegisterInput, client: ClientInfo): Promise<AuthResponse> {
    const existing = await this.store.findUserByEmail(input.email);
    if (existing) throw AppError.conflict("An account with this email already exists");

    const user = await this.store.createUser({
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
    });
    return { user: toPublicUser(user), tokens: await this.issueTokens(user, randomUUID(), client) };
  }

  async login(input: LoginInput, client: ClientInfo): Promise<AuthResponse> {
    const user = await this.store.findUserByEmail(input.email);
    if (!user) {
      await verifyAgainstDummy(input.password);
      throw AppError.unauthenticated("Invalid email or password");
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      throw AppError.unauthenticated("Invalid email or password");
    }
    if (user.status !== "ACTIVE") throw AppError.forbidden("This account is suspended");

    await this.store.recordLogin(user.id);
    return { user: toPublicUser(user), tokens: await this.issueTokens(user, randomUUID(), client) };
  }

  /**
   * Refresh-token rotation with reuse detection: presenting an already-rotated
   * token revokes the whole token family (likely theft).
   */
  async refresh(refreshToken: string, client: ClientInfo): Promise<AuthResponse> {
    const session = await this.store.findSessionByTokenHash(hashToken(refreshToken));
    if (!session) throw AppError.unauthenticated("Invalid refresh token");

    if (session.revokedAt) {
      await this.store.revokeSessionFamily(session.familyId);
      throw AppError.unauthenticated("Refresh token has been revoked");
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthenticated("Refresh token has expired");
    }

    const user = await this.store.findUserById(session.userId);
    if (!user || user.status !== "ACTIVE") {
      await this.store.revokeSessionFamily(session.familyId);
      throw AppError.unauthenticated("Account is not active");
    }

    const nextToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * DAY_MS);
    const rotated = await this.store.rotateSession(session.id, {
      userId: user.id,
      tokenHash: hashToken(nextToken),
      familyId: session.familyId,
      expiresAt,
      ...client,
    });
    if (!rotated) {
      await this.store.revokeSessionFamily(session.familyId);
      throw AppError.unauthenticated("Refresh token has been revoked");
    }

    return {
      user: toPublicUser(user),
      tokens: await this.buildTokens(user, nextToken, expiresAt),
    };
  }

  async logout(refreshToken: string, userId: string): Promise<void> {
    const session = await this.store.findSessionByTokenHash(hashToken(refreshToken));
    // Ownership check: users can only revoke their own sessions.
    if (session && session.userId === userId) await this.store.revokeSession(session.id);
  }

  private async issueTokens(
    user: UserRecord,
    familyId: string,
    client: ClientInfo,
  ): Promise<AuthTokens> {
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * DAY_MS);
    await this.store.createSession({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt,
      ...client,
    });
    return this.buildTokens(user, refreshToken, expiresAt);
  }

  private async buildTokens(
    user: UserRecord,
    refreshToken: string,
    expiresAt: Date,
  ): Promise<AuthTokens> {
    return {
      accessToken: await this.tokens.signAccessToken({ userId: user.id, role: user.role }),
      accessTokenExpiresIn: this.tokens.accessTtlSeconds,
      refreshToken,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    };
  }
}
