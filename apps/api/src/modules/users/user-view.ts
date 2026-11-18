import type { PublicUser, UserRole } from "@dealmind/shared";

/** Columns needed to build a PublicUser. Never includes passwordHash. */
export const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  emailVerifiedAt: true,
  onboardingCompletedAt: true,
  createdAt: true,
} as const;

export interface UserViewRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  emailVerifiedAt: Date | null;
  onboardingCompletedAt: Date | null;
  createdAt: Date;
}

/** The single mapping from a user row to what the API may return. */
export function toPublicUser(user: UserViewRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: user.emailVerifiedAt !== null,
    onboardingCompleted: user.onboardingCompletedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}
