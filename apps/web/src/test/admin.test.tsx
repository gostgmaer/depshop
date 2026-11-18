/**
 * Phase 6.3 UI: the platform admin console. Role gate in the server layout,
 * reason-required audited actions, connector readiness without secrets,
 * privacy notices on analytics, single-job retry, AI configuration, and
 * loading/error states.
 */
import type {
  AdminDashboardView,
  AdminJobsView,
  AdminSourceView,
  AdminUserDetail,
  SearchAnalyticsView,
} from "@dealmind/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "@/app/(admin)/layout";
import { AdminDashboardView as DashboardPage } from "@/app/(admin)/admin/dashboard-view";
import AiModelsPage from "@/app/(admin)/admin/ai-models/page";
import AnalyticsPage from "@/app/(admin)/admin/analytics/page";
import JobsPage from "@/app/(admin)/admin/jobs/page";
import SourcesPage from "@/app/(admin)/admin/sources/page";
import UserPage from "@/app/(admin)/admin/users/[id]/page";
import { ApiError } from "@/lib/api";
import type * as AuthHooks from "@/lib/auth-hooks";
import { type AiModelsResponse, admin } from "@/services/admin";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

const server = { user: null as null | { id: string; email: string; name: string; role: string } };
vi.mock("@/lib/server-session", () => ({ getServerUser: vi.fn(async () => server.user) }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-pathname": "/admin/users" })),
}));
vi.mock("@/lib/auth-hooks", async (orig) => ({
  ...(await orig<typeof AuthHooks>()),
  useMe: () => ({
    data: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN" },
  }),
}));
vi.mock("@/services/admin", () => ({
  admin: {
    dashboard: vi.fn(),
    user: vi.fn(),
    userAction: vi.fn(),
    sources: vi.fn(),
    updateSource: vi.fn(),
    healthCheck: vi.fn(),
    aiModels: vi.fn(),
    saveAiModels: vi.fn(),
    aiHealth: vi.fn(),
    analytics: vi.fn(),
    jobs: vi.fn(),
    retryJob: vi.fn(),
  },
}));
const m = vi.mocked(admin);

const USER: AdminUserDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "asha@example.com",
  name: "Asha",
  role: "USER",
  status: "ACTIVE",
  emailVerified: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastLoginAt: "2026-11-16T00:00:00.000Z",
  activeSessions: 2,
  subscription: {
    plan: "FREE",
    effectivePlan: "FREE",
    status: "ACTIVE",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  },
  usage: {
    searchesTotal: 40,
    searches30d: 12,
    activeAlerts: 3,
    watchlists: 1,
    trackedProducts: 4,
    agentTokens30d: 1500,
  },
};

beforeEach(() => {
  navigation.params = {};
  navigation.pathname = "/admin";
});

describe("1–3. admin layout authorization", () => {
  it("redirects signed-out visitors, 404s non-admins and renders for admins", async () => {
    server.user = null;
    await expect(Layout({ children: null })).rejects.toThrow(
      "NEXT_REDIRECT:/login?next=%2Fadmin%2Fusers",
    );
    server.user = { id: "u", email: "u@example.com", name: "U", role: "USER" };
    await expect(Layout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    server.user = { id: "a", email: "a@example.com", name: "A", role: "ADMIN" };
    expect(await Layout({ children: null })).toBeTruthy();
  });
});

describe("dashboard", () => {
  it("labels estimates and shows failing checks", async () => {
    const d: AdminDashboardView = {
      generatedAt: "2026-11-17T00:00:00.000Z",
      platform: {
        users: 10,
        activeUsers30d: 4,
        newUsers7d: 2,
        newUsers30d: 5,
        suspendedUsers: 1,
        searches: { total: 30, completed: 20, partial: 5, failed: 5, last30d: 12 },
        activeAlerts: 7,
        trackedOffers: 9,
      },
      revenue: {
        subscriptions: {
          activePaid: 1,
          estimatedMrrPaise: 19_900,
          refundEvents30d: 0,
          collectedRevenueNote: "Collected payments are in the payment service.",
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
        checks: { db: "ok", worker: "fail", payments: "not_configured" },
        queues: [
          { name: "search-execution", waiting: 0, active: 0, delayed: 0, failed: 2, workers: 1 },
        ],
        deadLetters: 0,
        connectors: [
          {
            slug: "amazon_in",
            name: "Amazon India",
            status: "PENDING_CREDENTIALS",
            health: "UNKNOWN",
          },
        ],
      },
    };
    m.dashboard.mockResolvedValue(d);
    renderWithQuery(<DashboardPage />);
    expect(await screen.findByText("Estimated MRR (subscriptions)")).toBeInTheDocument();
    expect(screen.getByText(/Estimate from list prices/)).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getAllByText("Fail").length).toBeGreaterThan(0);
  });

  it("shows a retryable error state", async () => {
    m.dashboard.mockRejectedValueOnce(new ApiError(403, "FORBIDDEN", "Admin access required"));
    renderWithQuery(<DashboardPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Admin access required");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("4–6. user administration", () => {
  it("requires a reason to suspend and sends it to the API", async () => {
    const Page = UserPage;
    navigation.params = { id: USER.id };
    m.user.mockResolvedValue(USER);
    m.userAction.mockResolvedValue({ ...USER, status: "SUSPENDED", activeSessions: 0 });
    renderWithQuery(<Page />);
    await userEvent.click(await screen.findByRole("button", { name: /Suspend/ }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Suspend" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "abuse report");
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(m.userAction).toHaveBeenCalledWith(USER.id, "suspend", "abuse report"),
    );
    expect(await screen.findByText("User suspended.")).toBeInTheDocument();
  });

  it("offers no suspend action on the admin's own account", async () => {
    const Page = UserPage;
    navigation.params = { id: "admin-1" };
    m.user.mockResolvedValue({ ...USER, id: "admin-1", role: "ADMIN" });
    renderWithQuery(<Page />);
    expect(await screen.findByText(/This is your account/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Suspend/ })).not.toBeInTheDocument();
  });
});

describe("7–8. connectors", () => {
  const source = (over: Partial<AdminSourceView> = {}): AdminSourceView => ({
    id: "22222222-2222-4222-8222-222222222222",
    slug: "amazon_in",
    name: "Amazon India",
    domain: "amazon.in",
    integrationKind: "OFFICIAL_API",
    status: "PENDING_CREDENTIALS",
    statusReason: null,
    isSample: false,
    credentials: {
      state: "PENDING_CREDENTIALS",
      configured: false,
      missing: ["AMAZON_CREATORS_CREDENTIAL_ID"],
      reason: null,
    },
    connectorRegistered: true,
    health: "UNKNOWN",
    lastHealthCheckAt: null,
    lastHealthError: null,
    lastSuccessAt: null,
    settings: {
      timeoutMs: 8000,
      rateLimitPerMinute: 60,
      maxRetries: 2,
      cacheTtlSeconds: 900,
      trackingEnabled: true,
      affiliateEnabled: false,
    },
    metrics: {
      requests: 0,
      failures: 0,
      timeouts: 0,
      rateLimitEvents: 0,
      results: 0,
      averageLatencyMs: null,
      lastErrorCategory: null,
    },
    searchRuns30d: { total: 0, failed: 0, timedOut: 0, averageMs: null, results: 0 },
    ...over,
  });

  it("lists missing credentials by name and blocks enabling until configured", async () => {
    const Page = SourcesPage;
    m.sources.mockResolvedValue([source()]);
    renderWithQuery(<Page />);
    expect(await screen.findByText("AMAZON_CREATORS_CREDENTIAL_ID")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Enable/ })).toBeDisabled();
  });

  it("disables an active source with a reason", async () => {
    const Page = SourcesPage;
    const s = source({
      status: "ACTIVE",
      credentials: { state: "READY", configured: true, missing: [], reason: null },
    });
    m.sources.mockResolvedValue([s]);
    m.updateSource.mockResolvedValue(s);
    renderWithQuery(<Page />);
    await userEvent.click(await screen.findByRole("button", { name: /Disable/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "partner outage");
    await userEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(m.updateSource).toHaveBeenCalledWith(s.id, {
        status: "DISABLED",
        reason: "partner outage",
      }),
    );
  });
});

describe("9. AI configuration", () => {
  it("never asks for an API key and saves with a reason", async () => {
    const Page = AiModelsPage;
    const res: AiModelsResponse = {
      config: {
        purpose: "INTENT_EXTRACTION",
        provider: "rules",
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
        runs: 0,
        failedRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
        byModel: [],
        estimatedCostPaise: null,
        limitReached: false,
      },
    };
    m.aiModels.mockResolvedValue(res);
    m.saveAiModels.mockResolvedValue(res);
    renderWithQuery(<Page />);
    expect(await screen.findByText(/Not set yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Provider"), "google");
    await userEvent.type(screen.getByLabelText(/^Model/), "gemini-test");
    await userEvent.type(screen.getByLabelText(/^Reason/), "try gemini");
    await userEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() =>
      expect(m.saveAiModels).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "google",
          model: "gemini-test",
          fallbackProvider: null,
          reason: "try gemini",
        }),
      ),
    );
  });
});

describe("10, 15. analytics privacy", () => {
  it("states the privacy threshold and shows only aggregate queries", async () => {
    const Page = AnalyticsPage;
    const a: SearchAnalyticsView = {
      days: 30,
      total: 5,
      byStatus: { COMPLETED: 4, FAILED: 1 },
      successRateBp: 8000,
      partialRateBp: 0,
      averageDurationMs: 4200,
      popularQueries: [{ query: "best phone under 30k", searches: 3, users: 3 }],
      emptyResultQueries: [],
      minUsers: 3,
      categories: [],
      connectors: [],
      agentRuns: { total: 5, failed: 0, cancelled: 0 },
      daily: [{ day: "2026-11-16", searches: 5, failed: 1 }],
    };
    m.analytics.mockResolvedValue(a);
    renderWithQuery(<Page />);
    expect(await screen.findByText("best phone under 30k")).toBeInTheDocument();
    expect(screen.getByText(/Searched by at least 3 people/)).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
  });
});

describe("13. jobs", () => {
  it("retries exactly one failed job after a reason", async () => {
    const Page = JobsPage;
    const j: AdminJobsView = {
      queues: [{ name: "alert-evaluation", counts: { failed: 1 }, workers: 1, paused: false }],
      failed: [
        {
          queue: "alert-evaluation",
          id: "alerts.x",
          name: "alert-evaluation",
          attemptsMade: 3,
          failedReason: "db timeout",
          failedAt: null,
        },
      ],
      deadLetters: [],
    };
    m.jobs.mockResolvedValue(j);
    m.retryJob.mockResolvedValue({ retried: true });
    renderWithQuery(<Page />);
    await userEvent.click(await screen.findByRole("button", { name: /Retry/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "transient");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry job" }));
    await waitFor(() => expect(m.retryJob).toHaveBeenCalledTimes(1));
    expect(m.retryJob).toHaveBeenCalledWith("alert-evaluation", "alerts.x", "transient");
    expect(screen.queryByRole("button", { name: /retry all/i })).not.toBeInTheDocument();
  });
});
