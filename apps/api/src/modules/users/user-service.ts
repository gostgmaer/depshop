import type { PrismaClient } from "@dealmind/db";
import {
  AppError,
  ErrorCode,
  type Preferences,
  type PublicUser,
  type UpdatePreferencesInput,
  type UpdateProfileInput,
  localeSchema,
} from "@dealmind/shared";
import type { AuthContext, SessionService } from "../auth/session-service.js";
import { type IamClient, IamError, splitName } from "../iam/iam-client.js";
import { toPublicUser, userSelect } from "./user-view.js";

const preferenceSelect = {
  preferredSourceIds: true,
  preferredBrands: true,
  notifyEmail: true,
  notifyInApp: true,
  locale: true,
} as const;

/**
 * Profile and preferences. Every method takes the userId of the AUTHENTICATED
 * principal; there is no way to address another user's records.
 */
export class UserService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly iam: IamClient,
  ) {}

  async getMe(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw AppError.notFound("User");
    return toPublicUser(user);
  }

  /**
   * Records that the first-time introduction was finished or skipped. The first
   * outcome wins and later calls change nothing (one conditional UPDATE, so two
   * tabs closing it at once can't overwrite each other).
   */
  async completeOnboarding(userId: string, outcome: "completed" | "skipped"): Promise<PublicUser> {
    await this.prisma.user.updateMany({
      where: { id: userId, onboardingCompletedAt: null },
      data: { onboardingCompletedAt: new Date(), onboardingSkipped: outcome === "skipped" },
    });
    return this.getMe(userId);
  }

  /** The IAM is the source of truth for names: update it first, then the mirror. */
  async updateProfile(auth: AuthContext, input: UpdateProfileInput): Promise<PublicUser> {
    const accessToken = await this.sessions.getIamAccessToken(auth.sessionId);
    try {
      await this.iam.updateProfile(accessToken, splitName(input.name));
    } catch (err) {
      if (err instanceof IamError && err.unavailable) {
        throw new AppError(
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          "The identity service is temporarily unavailable",
        );
      }
      if (err instanceof IamError) throw new AppError(ErrorCode.VALIDATION_ERROR, err.message);
      throw err;
    }
    const user = await this.prisma.user.update({
      where: { id: auth.userId },
      data: { name: input.name },
      select: userSelect,
    });
    return toPublicUser(user);
  }

  async getPreferences(userId: string): Promise<Preferences> {
    const prefs = await this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: preferenceSelect,
    });
    return { ...prefs, locale: localeSchema.catch("en-IN").parse(prefs.locale) };
  }

  async updatePreferences(userId: string, input: UpdatePreferencesInput): Promise<Preferences> {
    if (input.preferredSourceIds?.length) {
      const ids = [...new Set(input.preferredSourceIds)];
      const found = await this.prisma.shoppingSource.count({ where: { id: { in: ids } } });
      if (found !== ids.length) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Unknown shopping source in preferredSourceIds",
        );
      }
      input = { ...input, preferredSourceIds: ids };
    }
    if (input.preferredBrands) {
      input = {
        ...input,
        preferredBrands: [...new Set(input.preferredBrands.map((b) => b.trim()))],
      };
    }
    const prefs = await this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId, ...input },
      update: input,
      select: preferenceSelect,
    });
    return { ...prefs, locale: localeSchema.catch("en-IN").parse(prefs.locale) };
  }
}
