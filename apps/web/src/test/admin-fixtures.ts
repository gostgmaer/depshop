/**
 * TEST/E2E MOCK DATA ONLY — fictional admin-console responses ("Mock Store",
 * example.com users). Shapes are checked against the shared contracts in
 * contracts.test.ts. No figure here describes the real platform.
 */
import type {
  AdminAuditEntry,
  AdminDashboardView,
  AdminJobsView,
  AdminSourceView,
  AdminUserDetail,
  SearchAnalyticsView,
  SubscriptionAnalyticsView,
} from "@dealmind/shared";

const NOW = "2026-11-17T06:00:00.000Z";
export const ADMIN_MOCK_USER_ID = "60000000-0000-7000-8000-000000000002";
export const MOCK_SOURCE_ID = "30000000-0000-7000-8000-000000000001";

export const adminDashboard = (): AdminDashboardView => ({
  generatedAt: NOW,
  platform: {
    users: 12,
    activeUsers30d: 7,
    newUsers7d: 2,
    newUsers30d: 5,
    suspendedUsers: 0,
    searches: { total: 48, completed: 40, partial: 5, failed: 3, last30d: 30 },
    activeAlerts: 9,
    trackedOffers: 21,
  },
  revenue: {
    subscriptions: {
      activePaid: 0,
      estimatedMrrPaise: 0,
      refundEvents30d: 0,
      collectedRevenueNote: "E2E mock: collected payments live in the payment service.",
    },
    affiliate: {
      confirmedCommissionPaise: 0,
      confirmedConversions: 0,
      pendingCommissionPaise: 0,
      reversedCommissionPaise: 0,
      paidOutPaise: 0,
    },
  },
  infrastructure: {
    checks: {
      db: "ok",
      redis: "ok",
      iam: "ok",
      agent: "ok",
      worker: "ok",
      payments: "not_configured",
    },
    queues: [
      { name: "search-execution", waiting: 0, active: 0, delayed: 0, failed: 1, workers: 1 },
    ],
    deadLetters: 0,
    connectors: [{ slug: "mock_1", name: "Mock Store", status: "ACTIVE", health: "HEALTHY" }],
  },
});

export const adminUserDetailFixture = (): AdminUserDetail => ({
  id: ADMIN_MOCK_USER_ID,
  email: "ravi@example.com",
  name: "Ravi Mock",
  role: "USER",
  status: "ACTIVE",
  emailVerified: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastLoginAt: NOW,
  activeSessions: 1,
  subscription: {
    plan: "FREE",
    effectivePlan: "FREE",
    status: "ACTIVE",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  },
  usage: {
    searchesTotal: 6,
    searches30d: 4,
    activeAlerts: 1,
    watchlists: 1,
    trackedProducts: 2,
    agentTokens30d: 900,
  },
});

export const adminSources = (): AdminSourceView[] => [
  {
    id: MOCK_SOURCE_ID,
    slug: "mock_1",
    name: "Mock Store",
    domain: "mock-store.example",
    integrationKind: "MOCK",
    status: "ACTIVE",
    statusReason: null,
    isSample: true,
    credentials: { state: "READY", configured: true, missing: [], reason: null },
    connectorRegistered: true,
    health: "HEALTHY",
    lastHealthCheckAt: NOW,
    lastHealthError: null,
    lastSuccessAt: NOW,
    settings: {
      timeoutMs: 8000,
      rateLimitPerMinute: 60,
      maxRetries: 2,
      cacheTtlSeconds: 900,
      trackingEnabled: true,
      affiliateEnabled: false,
    },
    metrics: {
      requests: 30,
      failures: 1,
      timeouts: 0,
      rateLimitEvents: 0,
      results: 120,
      averageLatencyMs: 410,
      lastErrorCategory: null,
    },
    searchRuns30d: { total: 30, failed: 1, timedOut: 0, averageMs: 420, results: 120 },
  },
];

export const adminAiModels = () => ({
  config: {
    purpose: "INTENT_EXTRACTION",
    provider: "rules" as const,
    model: "",
    temperature: 0.2,
    maxTokens: 8192,
    enabled: true,
    fallbackProvider: null,
    fallbackModel: null,
    monthlyTokenLimit: null,
    inputPaisePerMillionTokens: null,
    outputPaisePerMillionTokens: null,
    updatedAt: null,
    stored: false,
  },
  usage: {
    month: "2026-11",
    runs: 4,
    failedRuns: 0,
    inputTokens: 1200,
    outputTokens: 300,
    byModel: [{ provider: "rules", model: "rules", runs: 4, inputTokens: 1200, outputTokens: 300 }],
    estimatedCostPaise: null,
    limitReached: false,
  },
});

export const adminAnalytics = (): SearchAnalyticsView => ({
  days: 30,
  total: 30,
  byStatus: { COMPLETED: 26, PARTIAL: 2, FAILED: 2 },
  successRateBp: 9333,
  partialRateBp: 667,
  averageDurationMs: 5200,
  popularQueries: [{ query: "acme phone under 30000", searches: 6, users: 4 }],
  emptyResultQueries: [],
  minUsers: 3,
  categories: [{ category: "Smartphones", searches: 20 }],
  connectors: [{ slug: "mock_1", runs: 30, failed: 1, timedOut: 0, averageMs: 420 }],
  agentRuns: { total: 30, failed: 1, cancelled: 0 },
  daily: [
    { day: "2026-11-15", searches: 10, failed: 1 },
    { day: "2026-11-16", searches: 12, failed: 1 },
    { day: "2026-11-17", searches: 8, failed: 0 },
  ],
});

export const adminSubscriptions = (): SubscriptionAnalyticsView => ({
  plans: [
    { plan: "FREE", users: 12 },
    { plan: "PRO", users: 0 },
    { plan: "BUSINESS", users: 0 },
  ],
  byStatus: {},
  activePaid: 0,
  pastDue: 0,
  cancelledOrEnded30d: 0,
  paymentFailures30d: 0,
  estimatedMrrPaise: 0,
  monthly: [],
  webhookEvents: {},
  note: "E2E mock: estimates from list prices.",
});

export const adminJobs = (): AdminJobsView => ({
  queues: [
    {
      name: "search-execution",
      counts: { waiting: 0, active: 0, failed: 1, completed: 40 },
      workers: 1,
      paused: false,
    },
  ],
  failed: [
    {
      queue: "search-execution",
      id: "search.mock-1",
      name: "search-execution",
      attemptsMade: 3,
      failedReason: "E2E mock: connector timeout",
      failedAt: NOW,
    },
  ],
  deadLetters: [],
});

export const adminAudit = (): AdminAuditEntry[] => [
  {
    id: "70000000-0000-7000-8000-000000000001",
    actorId: "60000000-0000-7000-8000-000000000009",
    actorEmail: "admin@example.com",
    action: "admin.source_updated",
    entity: "ShoppingSource",
    entityId: MOCK_SOURCE_ID,
    requestId: "req-e2e-1",
    metadata: {
      requestId: "req-e2e-1",
      reason: "E2E mock change",
      before: { timeoutMs: 8000 },
      after: { timeoutMs: 9000 },
    },
    createdAt: NOW,
  },
];
