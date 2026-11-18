/**
 * Platform admin contracts (Phase 6.3). Single-platform administration: the
 * only roles are USER and ADMIN; there is no tenant administration.
 * Every figure comes from stored data; money is integer paise and labelled
 * by certainty (confirmed / reported / estimated).
 */
import { z } from "zod";

const iso = z.string().datetime();
const paise = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const health = z.enum(["ok", "fail", "not_configured"]);

// ── Dashboard ─────────────────────────────────────────────────────────────

export const adminDashboardView = z.object({
  generatedAt: iso,
  platform: z.object({
    users: count,
    activeUsers30d: count,
    newUsers7d: count,
    newUsers30d: count,
    suspendedUsers: count,
    searches: z.object({
      total: count,
      completed: count,
      partial: count,
      failed: count,
      last30d: count,
    }),
    activeAlerts: count,
    trackedOffers: count,
  }),
  revenue: z.object({
    subscriptions: z.object({
      activePaid: count,
      /** List-price estimate: active paid subscriptions × plan price (annual ÷ 12). Excludes taxes, refunds and discounts. */
      estimatedMrrPaise: paise,
      /** Refund events received from the payment service in the last 30 days (count; amounts live in the payment service). */
      refundEvents30d: count,
      /** Collected subscription revenue lives in the shared payment service's ledger, not here. */
      collectedRevenueNote: z.string(),
    }),
    affiliate: z.object({
      /** APPROVED by the partner (confirmed). */
      confirmedCommissionPaise: paise,
      confirmedConversions: count,
      /** Reported by the partner but not yet approved. */
      pendingCommissionPaise: paise,
      reversedCommissionPaise: paise,
      paidOutPaise: paise,
    }),
  }),
  infrastructure: z.object({
    checks: z.record(health),
    queues: z.array(
      z.object({
        name: z.string(),
        waiting: count,
        active: count,
        delayed: count,
        failed: count,
        workers: count,
      }),
    ),
    deadLetters: count,
    connectors: z.array(
      z.object({ slug: z.string(), name: z.string(), status: z.string(), health: z.string() }),
    ),
  }),
});
export type AdminDashboardView = z.infer<typeof adminDashboardView>;

// ── Users ─────────────────────────────────────────────────────────────────

export const adminUserDetail = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["USER", "ADMIN"]),
  status: z.enum(["ACTIVE", "SUSPENDED"]),
  emailVerified: z.boolean(),
  createdAt: iso,
  lastLoginAt: iso.nullable(),
  activeSessions: count,
  subscription: z.object({
    plan: z.string(),
    effectivePlan: z.string(),
    status: z.string(),
    currentPeriodEnd: iso.nullable(),
    cancelAtPeriodEnd: z.boolean(),
  }),
  usage: z.object({
    searchesTotal: count,
    searches30d: count,
    activeAlerts: count,
    watchlists: count,
    trackedProducts: count,
    agentTokens30d: count,
  }),
});
export type AdminUserDetail = z.infer<typeof adminUserDetail>;

export const adminReasonInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

// ── Sources / connectors ──────────────────────────────────────────────────

export const adminSourceView = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  domain: z.string(),
  integrationKind: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  isSample: z.boolean(),
  /** Connector credentials present in the server environment (names only, never values). */
  /**
   * Connector readiness (Prompt 22): `configured` is true ONLY when the connector
   * reports READY. PENDING_APPROVAL (no authorized integration) and NOT_SUPPORTED
   * are never "configured", whatever credentials exist.
   */
  credentials: z.object({
    state: z.enum([
      "READY",
      "PENDING_CREDENTIALS",
      "PENDING_APPROVAL",
      "NOT_SUPPORTED",
      "NOT_REGISTERED",
    ]),
    configured: z.boolean(),
    missing: z.array(z.string()),
    reason: z.string().nullable(),
  }),
  connectorRegistered: z.boolean(),
  health: z.string(),
  lastHealthCheckAt: iso.nullable(),
  lastHealthError: z.string().nullable(),
  lastSuccessAt: iso.nullable(),
  settings: z.object({
    timeoutMs: z.number().int(),
    rateLimitPerMinute: z.number().int(),
    maxRetries: z.number().int(),
    cacheTtlSeconds: z.number().int(),
    trackingEnabled: z.boolean(),
    affiliateEnabled: z.boolean(),
  }),
  metrics: z.object({
    requests: count,
    failures: count,
    timeouts: count,
    rateLimitEvents: count,
    results: count,
    averageLatencyMs: z.number().int().nullable(),
    lastErrorCategory: z.string().nullable(),
  }),
  searchRuns30d: z.object({
    total: count,
    failed: count,
    timedOut: count,
    averageMs: z.number().int().nullable(),
    results: count,
  }),
});
export type AdminSourceView = z.infer<typeof adminSourceView>;

export const adminSourceUpdateInput = z
  .object({
    /** Only ACTIVE or DISABLED here; approval states are set by the integration review. */
    status: z.enum(["ACTIVE", "DISABLED"]),
    timeoutMs: z.number().int().min(1_000).max(60_000),
    rateLimitPerMinute: z.number().int().min(1).max(10_000),
    maxRetries: z.number().int().min(0).max(5),
    cacheTtlSeconds: z.number().int().min(0).max(86_400),
    trackingEnabled: z.boolean(),
    reason: z.string().trim().min(3).max(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "reason"), "Nothing to update");

// ── AI models ─────────────────────────────────────────────────────────────

export const AI_PROVIDERS = ["google", "openai", "rules"] as const;

export const aiModelConfigView = z.object({
  purpose: z.string(),
  provider: z.enum(AI_PROVIDERS),
  model: z.string(),
  temperature: z.number(),
  maxTokens: z.number().int(),
  enabled: z.boolean(),
  fallbackProvider: z.enum(AI_PROVIDERS).nullable(),
  fallbackModel: z.string().nullable(),
  monthlyTokenLimit: z.number().int().nullable(),
  inputPaisePerMillionTokens: z.number().int().nullable(),
  outputPaisePerMillionTokens: z.number().int().nullable(),
  updatedAt: iso.nullable(),
  /** False when no admin config exists and the agent uses its environment defaults. */
  stored: z.boolean(),
});
export type AiModelConfigView = z.infer<typeof aiModelConfigView>;

export const aiModelConfigInput = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    model: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9._:\-/]*$/, "Letters, digits and . _ : - / only"),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(256).max(200_000),
    enabled: z.boolean(),
    fallbackProvider: z.enum(AI_PROVIDERS).nullable(),
    fallbackModel: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9._:\-/]*$/)
      .nullable(),
    monthlyTokenLimit: z.number().int().positive().nullable(),
    inputPaisePerMillionTokens: z.number().int().nonnegative().nullable(),
    outputPaisePerMillionTokens: z.number().int().nonnegative().nullable(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((v) => v.provider === "rules" || v.model.length > 0, {
    path: ["model"],
    message: "Model is required",
  })
  .refine(
    (v) => (v.fallbackProvider === null) === (v.fallbackModel === null || v.fallbackModel === ""),
    {
      path: ["fallbackModel"],
      message: "Set both fallback provider and model, or neither",
    },
  );

export const aiUsageView = z.object({
  month: z.string(),
  runs: count,
  failedRuns: count,
  inputTokens: count,
  outputTokens: count,
  byModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      runs: count,
      inputTokens: count,
      outputTokens: count,
    }),
  ),
  /** From admin-entered prices; null when no prices are set. */
  estimatedCostPaise: paise.nullable(),
  limitReached: z.boolean(),
});

// ── Analytics ─────────────────────────────────────────────────────────────

export const searchAnalyticsView = z.object({
  days: z.number().int(),
  total: count,
  byStatus: z.record(count),
  successRateBp: z.number().int().nullable(),
  partialRateBp: z.number().int().nullable(),
  averageDurationMs: z.number().int().nullable(),
  /** Queries searched by at least `minUsers` different users (k-anonymity); text lower-cased, trimmed. */
  popularQueries: z.array(z.object({ query: z.string(), searches: count, users: count })),
  emptyResultQueries: z.array(z.object({ query: z.string(), searches: count, users: count })),
  minUsers: z.number().int(),
  categories: z.array(z.object({ category: z.string(), searches: count })),
  connectors: z.array(
    z.object({
      slug: z.string(),
      runs: count,
      failed: count,
      timedOut: count,
      averageMs: z.number().int().nullable(),
    }),
  ),
  agentRuns: z.object({ total: count, failed: count, cancelled: count }),
  daily: z.array(z.object({ day: z.string(), searches: count, failed: count })),
});
export type SearchAnalyticsView = z.infer<typeof searchAnalyticsView>;

export const subscriptionAnalyticsView = z.object({
  plans: z.array(z.object({ plan: z.string(), users: count })),
  byStatus: z.record(count),
  activePaid: count,
  pastDue: count,
  cancelledOrEnded30d: count,
  paymentFailures30d: count,
  estimatedMrrPaise: paise,
  /** New paid activations and cancellations per month (from the subscription audit trail). */
  monthly: z.array(
    z.object({
      month: z.string(),
      activations: count,
      cancellations: count,
      paymentFailures: count,
    }),
  ),
  webhookEvents: z.record(count),
  note: z.string(),
});
export type SubscriptionAnalyticsView = z.infer<typeof subscriptionAnalyticsView>;

// ── Jobs ──────────────────────────────────────────────────────────────────

export const adminQueueView = z.object({
  name: z.string(),
  counts: z.record(count),
  workers: count,
  paused: z.boolean(),
});
export const adminFailedJobView = z.object({
  queue: z.string(),
  id: z.string(),
  name: z.string(),
  attemptsMade: count,
  failedReason: z.string(),
  failedAt: iso.nullable(),
});
export type AdminFailedJobView = z.infer<typeof adminFailedJobView>;

export const adminJobsView = z.object({
  queues: z.array(adminQueueView),
  failed: z.array(adminFailedJobView),
  deadLetters: z.array(
    z.object({
      id: z.string(),
      queue: z.string(),
      jobId: z.string(),
      failedReason: z.string(),
      attemptsMade: count,
      failedAt: z.string(),
    }),
  ),
});
export type AdminJobsView = z.infer<typeof adminJobsView>;

// ── Audit ─────────────────────────────────────────────────────────────────

export const adminAuditEntry = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: iso,
});
export type AdminAuditEntry = z.infer<typeof adminAuditEntry>;
