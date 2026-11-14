/**
 * Zod schemas shared by the API (request/response validation) and the web app
 * (form validation), so both sides enforce identical rules.
 *
 * Input schemas are `.strict()`: unknown keys (e.g. a client-supplied `userId`
 * or `role`) are rejected rather than silently accepted.
 */
import { z } from "zod";

export const UserRole = z.enum(["USER", "ADMIN"]);
export type UserRole = z.infer<typeof UserRole>;

export const UserStatus = z.enum(["ACTIVE", "SUSPENDED"]);
export type UserStatus = z.infer<typeof UserStatus>;

export const PlanCode = z.enum(["FREE", "PRO", "BUSINESS"]);
export type PlanCode = z.infer<typeof PlanCode>;

// ── Primitives ────────────────────────────────────────────────────────────

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address")
  .max(254);

/** At least 10 characters with a letter and a digit; at most 128. */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a digit");

export const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name must be at most 100 characters");

/** Opaque single-use token from an email link (base64url, 256 bits). */
export const emailTokenSchema = z
  .string()
  .min(32, "Invalid or expired link")
  .max(128, "Invalid or expired link")
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid or expired link");

// ── Auth inputs ───────────────────────────────────────────────────────────

export const registerInput = z
  .object({ email: emailSchema, password: passwordSchema, name: nameSchema })
  .strict();
export type RegisterInput = z.infer<typeof registerInput>;

export const loginInput = z
  .object({ email: emailSchema, password: z.string().min(1, "Password is required").max(128) })
  .strict();
export type LoginInput = z.infer<typeof loginInput>;

export const verifyEmailInput = z.object({ token: emailTokenSchema }).strict();
export type VerifyEmailInput = z.infer<typeof verifyEmailInput>;

export const forgotPasswordInput = z.object({ email: emailSchema }).strict();
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInput>;

export const resetPasswordInput = z
  .object({ token: emailTokenSchema, password: passwordSchema })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordInput>;

export const changePasswordInput = z
  .object({
    currentPassword: z.string().min(1, "Current password is required").max(128),
    newPassword: passwordSchema,
  })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ["newPassword"],
    message: "New password must differ from the current password",
  });
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

// ── Profile & preferences ─────────────────────────────────────────────────

export const updateProfileInput = z.object({ name: nameSchema }).strict();
export type UpdateProfileInput = z.infer<typeof updateProfileInput>;

export const SUPPORTED_LOCALES = ["en-IN", "hi-IN"] as const;
export const localeSchema = z.enum(SUPPORTED_LOCALES);

export const preferencesSchema = z.object({
  preferredSourceIds: z.array(z.string().uuid()).max(50),
  preferredBrands: z.array(z.string().trim().min(1).max(50)).max(50),
  notifyEmail: z.boolean(),
  notifyInApp: z.boolean(),
  locale: localeSchema,
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const updatePreferencesInput = preferencesSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one preference" });
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesInput>;

// ── Responses ─────────────────────────────────────────────────────────────

/** The only user shape ever returned by the API. Never includes secrets. */
export const publicUser = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: UserRole,
  emailVerified: z.boolean(),
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof publicUser>;

export const meResponse = z.object({ user: publicUser });
export type MeResponse = z.infer<typeof meResponse>;

/** A session as shown to its owner. Token material is never exposed. */
export const sessionView = z.object({
  id: z.string().uuid(),
  current: z.boolean(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
});
export type SessionView = z.infer<typeof sessionView>;

export const sessionsResponse = z.object({ sessions: z.array(sessionView) });
export type SessionsResponse = z.infer<typeof sessionsResponse>;

export const messageResponse = z.object({ message: z.string() });
export type MessageResponse = z.infer<typeof messageResponse>;

/** Price range filter expressed in integer paise. */
export const priceRangeSchema = z
  .object({
    minPaise: z.number().int().nonnegative().optional(),
    maxPaise: z.number().int().nonnegative().optional(),
  })
  .refine((r) => r.minPaise == null || r.maxPaise == null || r.minPaise <= r.maxPaise, {
    message: "minPaise must be <= maxPaise",
  });
export type PriceRange = z.infer<typeof priceRangeSchema>;

/** Header carrying the CSRF token on state-changing requests. */
export const CSRF_HEADER = "x-csrf-token";
