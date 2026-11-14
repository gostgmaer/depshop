/**
 * Authentication as a BFF in front of the shared EasyDev IAM.
 *
 * The IAM owns credentials, email verification, password reset/change and its
 * own sessions. DealMind adds what a browser-facing app needs on top:
 *  - its own HttpOnly cookie sessions holding encrypted IAM tokens;
 *  - account-enumeration-safe responses (the IAM returns 409 for duplicates);
 *  - per-account login throttling and session rotation;
 *  - a local User mirror (keyed by IAM user id) for DealMind data ownership,
 *    plus DealMind-specific role and status.
 */
import type { PrismaClient } from "@dealmind/db";
import {
  AppError,
  DEFAULT_PLANS,
  ErrorCode,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
} from "@dealmind/shared";
import type { LoginThrottle } from "../../lib/login-throttle.js";
import {
  type IamClient,
  IamError,
  type IamUserProfile,
  displayNameOf,
  splitName,
} from "../iam/iam-client.js";
import type { IamTokenVerifier } from "../iam/iam-token-verifier.js";
import { recordAudit } from "../users/audit.js";
import { toPublicUser, userSelect } from "../users/user-view.js";
import type { AuthContext, ClientInfo, IssuedSession, SessionService } from "./session-service.js";

/** Same response for new and existing emails: registration must not enumerate accounts. */
export const REGISTER_MESSAGE =
  "Thanks! If this email can be registered, we've sent a link to verify it. Check your inbox.";
export const FORGOT_PASSWORD_MESSAGE =
  "If an account exists for this email, we've sent a link to reset the password.";
export const INVALID_CREDENTIALS = "Invalid email or password";
export const INVALID_LINK = "This link is invalid or has expired";

const unavailable = () =>
  new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, "The identity service is temporarily unavailable");

/** Re-throws IAM outages as 503 and appUrl misconfiguration as 500; returns other IAM errors. */
function iamFailure(err: unknown): IamError {
  if (err instanceof IamError) {
    if (err.unavailable) throw unavailable();
    if (err.appUrlRejected) {
      // APP_URL is not registered as an application in the IAM: email links
      // cannot be generated for DealMind. This is a deployment error.
      throw new AppError(
        ErrorCode.INTERNAL,
        "Email links are misconfigured (APP_URL is not registered with the IAM)",
      );
    }
    return err;
  }
  throw err;
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly iam: IamClient,
    private readonly verifier: IamTokenVerifier,
    private readonly throttle: LoginThrottle,
  ) {}

  // ── Registration & login ────────────────────────────────────────────────

  async register(input: RegisterInput, client: ClientInfo): Promise<void> {
    try {
      await this.iam.register({
        email: input.email,
        password: input.password,
        ...splitName(input.name),
        ...(client.ipAddress ? { clientIp: client.ipAddress } : {}),
      });
    } catch (err) {
      const e = iamFailure(err);
      if (e.status === 409) return; // existing account: identical response
      if (e.status === 403) throw AppError.forbidden("Sign-up is currently closed");
      if (e.status === 429)
        throw new AppError(ErrorCode.RATE_LIMITED, "Too many attempts. Try again later.");
      if (e.status === 400 || e.status === 422) {
        // IAM-side validation (e.g. disposable email domain). Not enumeration-sensitive.
        throw new AppError(ErrorCode.VALIDATION_FAILED, e.message);
      }
      throw e;
    }
  }

  /**
   * Signs in through the IAM and starts a NEW DealMind session. Any session
   * presented with the request is revoked first (session-fixation defence).
   */
  async login(
    input: LoginInput,
    client: ClientInfo,
    presentedSession: AuthContext | null,
  ): Promise<{ user: PublicUser; session: IssuedSession }> {
    const key = input.email;
    if (this.throttle.isLocked(key)) {
      throw new AppError(ErrorCode.RATE_LIMITED, "Too many sign-in attempts. Try again later.");
    }

    let result;
    try {
      result = await this.iam.login(input.email, input.password, client.ipAddress);
    } catch (err) {
      const e = iamFailure(err);
      if (e.status === 401 || e.status === 404) {
        this.throttle.recordFailure(key);
        throw AppError.unauthenticated(INVALID_CREDENTIALS);
      }
      if (e.status === 429)
        throw new AppError(ErrorCode.RATE_LIMITED, "Too many sign-in attempts. Try again later.");
      if (e.status === 403) throw AppError.forbidden(e.message);
      throw e;
    }

    const claims = await this.verifier.verify(result.accessToken);
    if (claims.sub !== result.user.id) throw unavailable(); // inconsistent IAM response

    const user = await this.upsertMirror(result.user, claims.isEmailVerified);
    if (user.status !== "ACTIVE") {
      await this.iam.logout(result.accessToken).catch(() => undefined);
      throw AppError.forbidden("This account is suspended");
    }

    this.throttle.recordSuccess(key);
    if (presentedSession) await this.sessions.revoke(presentedSession.sessionId);
    const session = await this.sessions.create(user.id, client, { tokens: result, claims });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return { user: toPublicUser(user), session };
  }

  /** Creates or refreshes the local mirror of an IAM identity. */
  private async upsertMirror(profile: IamUserProfile, emailVerified: boolean) {
    const email = profile.email.toLowerCase();
    const name = displayNameOf(profile).slice(0, 100);
    const verifiedAt = emailVerified || profile.isEmailVerified ? new Date() : null;
    const existing = await this.prisma.user.findUnique({
      where: { iamUserId: profile.id },
      select: { id: true, emailVerifiedAt: true },
    });
    const select = { ...userSelect, status: true } as const;
    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: { email, name, emailVerifiedAt: existing.emailVerifiedAt ?? verifiedAt },
        select,
      });
    }
    const free = DEFAULT_PLANS.FREE;
    return this.prisma.user.create({
      data: {
        iamUserId: profile.id,
        email,
        name,
        emailVerifiedAt: verifiedAt,
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
      select,
    });
  }

  /** Ends the DealMind session and its IAM session (best effort). */
  async logout(auth: AuthContext): Promise<void> {
    const accessToken = await this.sessions.getIamAccessToken(auth.sessionId).catch(() => null);
    await this.sessions.revoke(auth.sessionId);
    if (accessToken) await this.iam.logout(accessToken).catch(() => undefined);
  }

  // ── Email verification ─────────────────────────────────────────────────

  async verifyEmail(token: string, auth: AuthContext | null): Promise<void> {
    try {
      await this.iam.verifyEmail(token);
    } catch (err) {
      const e = iamFailure(err);
      if (e.status === 400 || e.status === 404 || e.status === 410) {
        throw new AppError(ErrorCode.BAD_REQUEST, INVALID_LINK);
      }
      throw e;
    }
    // If the verifying browser is signed in, reflect the change immediately.
    if (auth) {
      await this.prisma.user.updateMany({
        where: { id: auth.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
    }
  }

  async resendVerification(auth: AuthContext): Promise<"sent" | "already-verified"> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (user.emailVerifiedAt) return "already-verified";
    try {
      await this.iam.sendVerification(user.email);
    } catch (err) {
      const e = iamFailure(err);
      if (e.status === 429)
        throw new AppError(ErrorCode.RATE_LIMITED, "Please wait before requesting another email.");
      throw e;
    }
    return "sent";
  }

  // ── Password reset & change ─────────────────────────────────────────────

  async forgotPassword(email: string, client: ClientInfo): Promise<void> {
    try {
      await this.iam.forgotPassword(email, client.ipAddress);
    } catch (err) {
      const e = iamFailure(err);
      if (e.status === 429)
        throw new AppError(ErrorCode.RATE_LIMITED, "Too many requests. Try again later.");
      // Any other IAM answer is swallowed: the response must not reveal account existence.
    }
  }

  /**
   * Sets a new password from a reset link. The IAM revokes the account's IAM
   * sessions; DealMind sessions follow at their next IAM revalidation.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    try {
      await this.iam.resetPassword(token, password);
    } catch (err) {
      const e = iamFailure(err);
      if (e.status === 400 || e.status === 404 || e.status === 410) {
        throw new AppError(ErrorCode.BAD_REQUEST, INVALID_LINK);
      }
      throw e;
    }
  }

  /**
   * Changes the password in the IAM, revokes all OTHER sessions (DealMind and
   * their IAM sessions) and rotates the current DealMind session identifier.
   */
  async changePassword(
    auth: AuthContext,
    currentPassword: string,
    newPassword: string,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const accessToken = await this.sessions.getIamAccessToken(auth.sessionId);
    try {
      await this.iam.changePassword(accessToken, currentPassword, newPassword);
    } catch (err) {
      const e = iamFailure(err);
      if (e.status === 400 || e.status === 401 || e.status === 403) {
        throw new AppError(ErrorCode.BAD_REQUEST, "Current password is incorrect");
      }
      throw e;
    }
    const otherIamSessions = await this.sessions.revokeAllForUser(auth.userId, auth.sessionId);
    await Promise.all(
      otherIamSessions.map((id) => this.iam.revokeSession(accessToken, id).catch(() => undefined)),
    );
    const rotated = await this.sessions.rotate(auth.sessionId, auth.userId, client);
    await recordAudit(this.prisma, {
      actorId: auth.userId,
      action: "auth.password_changed",
      entity: "User",
      entityId: auth.userId,
    });
    return rotated;
  }

  /** Revokes one of the caller's DealMind sessions and its IAM session. */
  async revokeSession(auth: AuthContext, sessionId: string): Promise<void> {
    const accessToken = await this.sessions.getIamAccessToken(auth.sessionId).catch(() => null);
    const { revoked, iamSessionId } = await this.sessions.revokeOwned(auth.userId, sessionId);
    if (!revoked) throw AppError.notFound("Session");
    if (accessToken && iamSessionId) {
      await this.iam.revokeSession(accessToken, iamSessionId).catch(() => undefined);
    }
  }
}
