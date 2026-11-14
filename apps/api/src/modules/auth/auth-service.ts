import { type AuthTokenType, type PrismaClient, isUniqueViolation } from "@dealmind/db";
import {
  AppError,
  DEFAULT_PLANS,
  ErrorCode,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
} from "@dealmind/shared";
import type { LoginThrottle } from "../../lib/login-throttle.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../lib/password.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import type { EmailService } from "../email/email-service.js";
import { recordAudit } from "../users/audit.js";
import { toPublicUser, userSelect } from "../users/user-view.js";
import type { AuthContext, ClientInfo, IssuedSession, SessionService } from "./session-service.js";

export interface AuthServiceOptions {
  emailVerificationTtlHours: number;
  passwordResetTtlMinutes: number;
}

/** Same response for new and existing emails: registration must not enumerate accounts. */
export const REGISTER_MESSAGE =
  "Thanks! If this email can be registered, we've sent a link to verify it. Check your inbox.";
export const FORGOT_PASSWORD_MESSAGE =
  "If an account exists for this email, we've sent a link to reset the password.";
export const INVALID_CREDENTIALS = "Invalid email or password";
export const INVALID_LINK = "This link is invalid or has expired";

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly email: EmailService,
    private readonly throttle: LoginThrottle,
    private readonly opts: AuthServiceOptions,
  ) {}

  // ── Registration & login ────────────────────────────────────────────────

  async register(input: RegisterInput): Promise<void> {
    // Hash first, unconditionally, so new and existing emails take equal time.
    const passwordHash = await hashPassword(input.password);

    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      void this.email.sendAccountExists(input.email);
      return;
    }

    let user: { id: string };
    try {
      const free = DEFAULT_PLANS.FREE;
      user = await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
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
        select: { id: true },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Concurrent registration of the same email: behave as "exists".
        void this.email.sendAccountExists(input.email);
        return;
      }
      throw err;
    }

    const token = await this.issueToken(
      user.id,
      "EMAIL_VERIFICATION",
      this.opts.emailVerificationTtlHours * 3_600_000,
    );
    void this.email.sendVerification(
      input.email,
      input.name,
      token,
      this.opts.emailVerificationTtlHours,
    );
  }

  /**
   * Verifies credentials and starts a NEW session. Any session presented with
   * the request is revoked first (session-fixation defence: identifiers are
   * always rotated on login).
   */
  async login(
    input: LoginInput,
    client: ClientInfo,
    presentedSession: AuthContext | null,
  ): Promise<{ user: PublicUser; session: IssuedSession }> {
    const key = input.email;
    if (this.throttle.isLocked(key)) {
      await verifyAgainstDummy(input.password);
      throw new AppError(ErrorCode.RATE_LIMITED, "Too many sign-in attempts. Try again later.");
    }

    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { ...userSelect, passwordHash: true, status: true },
    });
    if (!user) {
      await verifyAgainstDummy(input.password);
      this.throttle.recordFailure(key);
      throw AppError.unauthenticated(INVALID_CREDENTIALS);
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      this.throttle.recordFailure(key);
      throw AppError.unauthenticated(INVALID_CREDENTIALS);
    }
    // Only reachable with the correct password, so this reveals nothing to guessers.
    if (user.status !== "ACTIVE") throw AppError.forbidden("This account is suspended");

    this.throttle.recordSuccess(key);
    if (presentedSession) await this.sessions.revoke(presentedSession.sessionId);
    const session = await this.sessions.create(user.id, client);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return { user: toPublicUser(user), session };
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.sessions.revoke(auth.sessionId);
  }

  // ── Email verification ─────────────────────────────────────────────────

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeToken(token, "EMAIL_VERIFICATION");
    await this.prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  }

  async resendVerification(auth: AuthContext): Promise<"sent" | "already-verified"> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { email: true, name: true, emailVerifiedAt: true },
    });
    if (user.emailVerifiedAt) return "already-verified";
    const ttl = this.opts.emailVerificationTtlHours;
    const token = await this.issueToken(auth.userId, "EMAIL_VERIFICATION", ttl * 3_600_000);
    void this.email.sendVerification(user.email, user.name, token, ttl);
    return "sent";
  }

  // ── Password reset & change ─────────────────────────────────────────────

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true },
    });
    if (!user || user.status !== "ACTIVE") return;
    const ttl = this.opts.passwordResetTtlMinutes;
    const token = await this.issueToken(user.id, "PASSWORD_RESET", ttl * 60_000);
    void this.email.sendPasswordReset(email, token, ttl);
  }

  /**
   * Sets a new password from a reset link. Signs out EVERY session (the reset
   * may be in response to a compromise) and does not sign the user in.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    const userId = await this.consumeToken(token, "PASSWORD_RESET");
    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        // Following the emailed link proves control of the inbox.
        ...(current.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
      },
      select: { email: true },
    });
    await this.prisma.authToken.deleteMany({
      where: { userId, type: "PASSWORD_RESET", usedAt: null },
    });
    await this.sessions.revokeAllForUser(userId);
    this.throttle.recordSuccess(user.email);
    await recordAudit(this.prisma, {
      actorId: userId,
      action: "auth.password_reset",
      entity: "User",
      entityId: userId,
    });
    void this.email.sendPasswordChanged(user.email);
  }

  /**
   * Changes the password for a signed-in user, revokes all OTHER sessions and
   * rotates the current session identifier.
   */
  async changePassword(
    auth: AuthContext,
    currentPassword: string,
    newPassword: string,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { email: true, passwordHash: true },
    });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new AppError(ErrorCode.BAD_REQUEST, "Current password is incorrect");
    }
    await this.prisma.user.update({
      where: { id: auth.userId },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    await this.sessions.revokeAllForUser(auth.userId, auth.sessionId);
    const rotated = await this.sessions.rotate(auth.sessionId, auth.userId, client);
    await recordAudit(this.prisma, {
      actorId: auth.userId,
      action: "auth.password_changed",
      entity: "User",
      entityId: auth.userId,
    });
    void this.email.sendPasswordChanged(user.email);
    return rotated;
  }

  // ── Single-use email tokens ─────────────────────────────────────────────

  /** Issues a new token, invalidating any outstanding token of the same type. */
  private async issueToken(userId: string, type: AuthTokenType, ttlMs: number): Promise<string> {
    const token = generateToken();
    await this.prisma.$transaction([
      this.prisma.authToken.deleteMany({ where: { userId, type, usedAt: null } }),
      this.prisma.authToken.create({
        data: {
          userId,
          type,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      }),
    ]);
    return token;
  }

  /** Atomically marks a valid token as used and returns its user, or throws. */
  private async consumeToken(token: string, type: AuthTokenType): Promise<string> {
    const record = await this.prisma.authToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, type: true, usedAt: true, expiresAt: true },
    });
    if (!record || record.type !== type || record.usedAt || record.expiresAt <= new Date()) {
      throw new AppError(ErrorCode.BAD_REQUEST, INVALID_LINK);
    }
    // Conditional update: only one concurrent request can consume the token.
    const claimed = await this.prisma.authToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw new AppError(ErrorCode.BAD_REQUEST, INVALID_LINK);
    return record.userId;
  }
}
