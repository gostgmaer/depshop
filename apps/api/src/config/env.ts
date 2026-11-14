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
    /** Required: caching, rate limits, login throttling and BullMQ queues. */
    REDIS_URL: z.string().url(),
    /** Namespace for every Redis key DealMind writes (cache, rate limits, queues). */
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9:_-]{1,40}$/, "lowercase letters, digits, : _ - only")
      .default("dm"),
    /** TTL for cached shared catalog reads (categories, product detail). */
    CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),

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

    /**
     * AES-256-GCM key (32 bytes, base64) encrypting the IAM tokens stored in
     * DealMind sessions. Rotating it signs every user out.
     */
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .refine(
        (v) => Buffer.from(v, "base64").length === 32,
        "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64",
      ),

    // ── Shared EasyDev IAM (identity provider) ─────────────────────────
    /** IAM API base, e.g. http://127.0.0.1:3304/api/v1/iam */
    IAM_BASE_URL: z
      .string()
      .url()
      .transform((v) => v.replace(/\/+$/, "")),
    /** x-tenant-id sent to the IAM. A config constant: DealMind itself has no tenancy. */
    IAM_TENANT: z.string().min(1).default("easydev"),
    IAM_JWT_ISSUER: z.string().min(1).default("iam-service"),
    IAM_JWT_AUDIENCE: z.string().min(1).default("easydev"),
    /** Defaults to <IAM_BASE_URL>/.well-known/jwks.json */
    IAM_JWKS_URL: z.string().url().optional(),
    IAM_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8_000),

    // ── Shared EasyDev notification service (optional until used) ──────
    NOTIFICATION_SERVICE_URL: z.string().url().optional(),
    NOTIFICATION_API_KEY: z.string().optional(),
    NOTIFICATION_TENANT_ID: z.string().min(1).default("dealmind"),

    // ── Shared EasyDev file-upload service (optional until used) ───────
    FILE_SERVICE_URL: z.string().url().optional(),
    FILE_SERVICE_HMAC_SECRET: z.string().optional(),
    FILE_SERVICE_TENANT_ID: z.string().min(1).default("dealmind"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
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
    IAM_JWKS_URL: env.IAM_JWKS_URL ?? `${env.IAM_BASE_URL}/.well-known/jwks.json`,
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
