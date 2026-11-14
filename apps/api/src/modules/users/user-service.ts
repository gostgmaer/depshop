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
  constructor(private readonly prisma: PrismaClient) {}

  async getMe(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw AppError.notFound("User");
    return toPublicUser(user);
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<PublicUser> {
    const user = await this.prisma.user.update({
      where: { id: userId },
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
          ErrorCode.VALIDATION_FAILED,
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
