import { z } from "zod";

const bool = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((v) => v === "true");

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /** Which proxies to trust for client IPs: "loopback", "true", or a CIDR list. */
    TRUST_PROXY: z.string().default("loopback"),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().optional(),

    /** Public origin of the web app; used for email links and the Origin allow-list. */
    APP_URL: z.string().url().default("http://localhost:3000"),
    /** Extra origins allowed to call the API with cookies (comma-separated). */
    CORS_ORIGINS: csv(""),
    API_DOCS_ENABLED: bool("true"),

    /** HMAC key for CSRF tokens. Min 32 chars; rotate to invalidate all CSRF tokens. */
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    /** Absolute session lifetime. */
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** Sessions unused for this long expire. */
    SESSION_IDLE_TIMEOUT_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** Defaults to true in production. Must be true whenever served over HTTPS. */
    COOKIE_SECURE: z.enum(["true", "false"]).optional(),

    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(240).default(30),

    /** "smtp" sends real mail (Mailpit in development); "console" only logs. */
    EMAIL_TRANSPORT: z.enum(["smtp", "console"]).default("console"),
    EMAIL_FROM: z.string().min(3).default("DealMind AI <no-reply@dealmind.local>"),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_SECURE: bool("false"),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_TRANSPORT === "smtp" && !env.SMTP_HOST) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_HOST"],
        message: "required when EMAIL_TRANSPORT=smtp",
      });
    }
    if (env.NODE_ENV === "production") {
      if (env.EMAIL_TRANSPORT !== "smtp") {
        ctx.addIssue({
          code: "custom",
          path: ["EMAIL_TRANSPORT"],
          message: "must be smtp in production",
        });
      }
      if (env.COOKIE_SECURE === "false") {
        ctx.addIssue({
          code: "custom",
          path: ["COOKIE_SECURE"],
          message: "must not be false in production",
        });
      }
    }
    if (env.SESSION_IDLE_TIMEOUT_DAYS > env.SESSION_TTL_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_IDLE_TIMEOUT_DAYS"],
        message: "must not exceed SESSION_TTL_DAYS",
      });
    }
  })
  .transform((env) => ({
    ...env,
    COOKIE_SECURE: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : env.NODE_ENV === "production",
    /** Every origin allowed to make cookie-authenticated, state-changing requests. */
    ALLOWED_ORIGINS: [...new Set([new URL(env.APP_URL).origin, ...env.CORS_ORIGINS])],
  }));

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
