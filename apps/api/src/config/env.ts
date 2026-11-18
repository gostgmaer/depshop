import { z } from "zod";

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
    /** Cache TTLs (seconds) for shared catalog reads; 0 disables that cache. */
    CATALOG_CATEGORY_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(3_600),
    CATALOG_PRODUCT_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    /** Offer lists/summaries: kept short so prices are never shown long after they change. */
    CATALOG_OFFER_TTL_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
    CATALOG_HISTORY_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    /** An offer not observed for this many hours is stale (never presented as live). */
    CATALOG_OFFER_STALE_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(24),

    /** Public origin of the web app; used for email links and the Origin allow-list. */
    APP_URL: z.string().url().default("http://localhost:3000"),
    /** Extra origins allowed to call the API with cookies (comma-separated). */
    CORS_ORIGINS: csv(""),
    /** OpenAPI docs at /docs. Default: on in development, OFF in production (attack surface). */
    API_DOCS_ENABLED: z.enum(["true", "false"]).optional(),

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
    /** Verifies email unsubscribe links (≥ 32 chars; same value in the worker). */
    NOTIFICATION_TOKEN_SECRET: z.string().min(32).optional(),
    /** Web push: the VAPID public key handed to browsers (the private key lives only in the worker). */
    VAPID_PUBLIC_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{80,100}$/, "VAPID_PUBLIC_KEY must be a base64url P-256 key")
      .optional(),

    // ── Billing (Phase 6.1) ────────────────────────────────────────────
    /**
     * "easydev-payments": the shared EasyDev payment service (Razorpay lives there).
     * "sandbox": test double, no money moves (refused in production).
     * "none": plans are shown but can't be bought.
     */
    BILLING_PROVIDER: z.enum(["none", "easydev-payments", "sandbox"]).default("none"),
    PAYMENT_SERVICE_URL: z.string().url().optional(),
    /** The payment service's service key (its API_KEY_HASH is the SHA-256 of this). */
    PAYMENT_SERVICE_API_KEY: z.string().optional(),
    /** The payment service's tenant for EasyDev customers (a config constant; DealMind has no tenancy). */
    PAYMENT_TENANT_ID: z.string().min(1).default("easydev"),
    /** IAM application id DealMind's plans are registered under in the payment service. */
    PAYMENT_APPLICATION_ID: z.string().min(1).default("dealmind"),
    /** Verifies the payment service's outbound webhooks (same value as its OUTBOUND_WEBHOOK_TARGETS secret). */
    PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
    /** Days of paid access kept after a failed renewal while payment is retried. */
    BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(14).default(3),

    // ── Shared EasyDev file-upload service (optional until used) ───────
    FILE_SERVICE_URL: z.string().url().optional(),
    FILE_SERVICE_HMAC_SECRET: z.string().optional(),
    FILE_SERVICE_TENANT_ID: z.string().min(1).default("dealmind"),

    // ── Internal service API (/internal/v1) for the Python agent ────────
    /** Bearer token the Python agent presents. Unset → internal API disabled (404). */
    INTERNAL_API_TOKEN: z.string().min(32).optional(),
    /** Bearer token for GET /metrics (Prometheus). Unset = no metrics endpoint. */
    METRICS_TOKEN: z.string().min(32).optional(),
    /** Python agent service (used for search cancellation). */
    AGENT_SERVICE_URL: z.string().url().optional(),
    AGENT_SERVICE_TOKEN: z.string().min(32).optional(),
    /** HMAC secret for signed user contexts (shared by worker, agent and API). */
    AGENT_USER_CONTEXT_SECRET: z.string().min(32).optional(),
    /** HMAC secret for signed reviewer contexts (admin backend only; never given to the agent). */
    REVIEW_CONTEXT_SECRET: z.string().min(32).optional(),

    // ── Connectors (executor runs here for the internal API) ────────────
    CONNECTORS_ENABLE_MOCKS: z.enum(["true", "false"]).optional(),
    CONNECTOR_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(6),
    FLIPKART_AFFILIATE_ID: z.string().optional(),
    FLIPKART_AFFILIATE_TOKEN: z.string().optional(),
    AMAZON_CREATORS_CREDENTIAL_ID: z.string().optional(),
    AMAZON_CREATORS_CREDENTIAL_SECRET: z.string().optional(),
    AMAZON_ASSOCIATES_PARTNER_TAG: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.CONNECTORS_ENABLE_MOCKS === "true") {
      ctx.addIssue({
        code: "custom",
        path: ["CONNECTORS_ENABLE_MOCKS"],
        message: "mock connectors are not allowed in production",
      });
    }
    if (env.NODE_ENV === "production") {
      if (env.COOKIE_SECURE === "false") {
        ctx.addIssue({
          code: "custom",
          path: ["COOKIE_SECURE"],
          message: "must not be false in production",
        });
      }
    }
    if (env.BILLING_PROVIDER === "sandbox" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["BILLING_PROVIDER"],
        message: "the sandbox billing provider is not allowed in production",
      });
    }
    if (
      env.BILLING_PROVIDER === "easydev-payments" &&
      (!env.PAYMENT_SERVICE_URL || !env.PAYMENT_SERVICE_API_KEY)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["BILLING_PROVIDER"],
        message: "easydev-payments needs PAYMENT_SERVICE_URL and PAYMENT_SERVICE_API_KEY",
      });
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
    API_DOCS_ENABLED: env.API_DOCS_ENABLED
      ? env.API_DOCS_ENABLED === "true"
      : env.NODE_ENV !== "production",
    /** Every origin allowed to make cookie-authenticated, state-changing requests. */
    ALLOWED_ORIGINS: [...new Set([new URL(env.APP_URL).origin, ...env.CORS_ORIGINS])],
    IAM_JWKS_URL: env.IAM_JWKS_URL ?? `${env.IAM_BASE_URL}/.well-known/jwks.json`,
    /** Mock connectors (fictional data): on outside production unless disabled. */
    CONNECTORS_ALLOW_MOCKS: env.CONNECTORS_ENABLE_MOCKS
      ? env.CONNECTORS_ENABLE_MOCKS === "true"
      : env.NODE_ENV !== "production",
  }));

export type Env = z.infer<typeof envSchema>;

/**
 * An empty variable means "unset": container orchestration (compose `${X:-}`)
 * passes optional settings as empty strings, which must neither fail
 * validation nor override defaults.
 */
export function withoutEmpty(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(withoutEmpty(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
