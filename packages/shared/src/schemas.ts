import { z } from "zod";

export const UserRole = z.enum(["USER", "ADMIN"]);
export type UserRole = z.infer<typeof UserRole>;

export const PlanCode = z.enum(["FREE", "PRO", "BUSINESS"]);
export type PlanCode = z.infer<typeof PlanCode>;

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/** Minimum 10 chars, at least one letter and one digit. */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a digit");

export const registerInput = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100),
});
export type RegisterInput = z.infer<typeof registerInput>;

export const loginInput = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginInput>;

export const refreshInput = z.object({ refreshToken: z.string().min(32).max(256) });
export type RefreshInput = z.infer<typeof refreshInput>;

export const publicUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: UserRole,
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof publicUser>;

export const authTokens = z.object({
  accessToken: z.string(),
  accessTokenExpiresIn: z.number().int(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string(),
});
export type AuthTokens = z.infer<typeof authTokens>;

export const authResponse = z.object({ user: publicUser, tokens: authTokens });
export type AuthResponse = z.infer<typeof authResponse>;

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
