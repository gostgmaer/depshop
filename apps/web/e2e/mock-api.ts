/**
 * E2E TEST SERVER ONLY — a stand-in for the Fastify API so Playwright can run
 * the production Next.js build (server components included) without a
 * database. Responses use the contract-checked fixtures from
 * src/test/fixtures.ts (fictional "Acme" products, "Mock Store" sources).
 *
 * Run: node e2e/mock-api.ts   (Node ≥ 23 strips TypeScript types natively)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  categoryFilters,
  priceHistory,
  productDetail,
  recommendations,
  productPricing,
  searchDetail,
  searchResult,
  searchResultVariant,
} from "../src/test/fixtures.ts";

const PORT = Number(process.env.MOCK_API_PORT ?? 4599);
const USER = {
  id: "60000000-0000-7000-8000-000000000001",
  email: "asha@example.com",
  name: "Asha Rao",
  role: "USER",
  emailVerified: true,
  createdAt: "2026-11-01T00:00:00.000Z",
};
const PRODUCT_ID = "10000000-0000-7000-8000-000000000001";
const SEARCH_ID = "40000000-0000-7000-8000-000000000001";
let searchFinished = false;
const page = <T>(items: T[]) => ({
  success: true,
  data: items,
  meta: {
    requestId: "e2e",
    pagination: { page: 1, pageSize: 20, total: items.length, totalPages: items.length ? 1 : 0 },
  },
});
const ok = <T>(data: T) => ({ success: true, data, meta: { requestId: "e2e" } });
const err = (code: string, message: string) => ({
  success: false,
  error: { code, message },
  meta: { requestId: "e2e" },
});

const mockLimits = (n: number) => ({
  searchesPerDay: 20 * n,
  activeAlerts: 5 * n,
  watchlists: 2 * n,
  trackedProducts: 25 * n,
  historyDays: n === 1 ? 90 : 365,
  compareItems: n === 1 ? 2 : 4,
  exportsPerMonth: n === 1 ? 0 : 10,
});
const MOCK_PLANS = [
  {
    code: "FREE",
    name: "Free",
    description: "Sample free plan",
    monthlyPricePaise: 0,
    annualPricePaise: null,
    limits: mockLimits(1),
    features: { prioritySearch: false, exports: false },
    purchasableIntervals: [],
  },
  {
    code: "PRO",
    name: "Pro",
    description: "Sample paid plan",
    monthlyPricePaise: 19_900,
    annualPricePaise: 199_000,
    limits: mockLimits(10),
    features: { prioritySearch: true, exports: true },
    purchasableIntervals: ["MONTHLY", "ANNUAL"],
  },
  {
    code: "BUSINESS",
    name: "Business",
    description: "Sample paid plan",
    monthlyPricePaise: 99_900,
    annualPricePaise: 999_000,
    limits: mockLimits(100),
    features: { prioritySearch: true, exports: true },
    purchasableIntervals: ["MONTHLY", "ANNUAL"],
  },
];

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const signedIn = (req: IncomingMessage) =>
  (req.headers.cookie ?? "").includes("dm_session=e2e-session");

const product = productDetail({ sampleData: false, modelNumber: null });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const method = req.method ?? "GET";

  // ── auth ──
  if (path === "/auth/csrf")
    return send(res, 200, ok({ csrfToken: "e2e-csrf" }), {
      "set-cookie": "dm_csrf=e2e-csrf; Path=/; SameSite=Lax",
    });
  if (path === "/auth/login" && method === "POST") {
    return send(res, 200, ok({ user: USER }), {
      "set-cookie": "dm_session=e2e-session; Path=/; HttpOnly; SameSite=Lax",
    });
  }
  if (path === "/auth/logout")
    return send(res, 200, ok({}), { "set-cookie": "dm_session=; Path=/; Max-Age=0" });
  if (path === "/auth/me")
    return signedIn(req)
      ? send(res, 200, ok({ user: USER }))
      : send(res, 401, err("UNAUTHENTICATED", "Sign in"));

  // ── public catalog ──
  if (path === "/categories/tree")
    return send(res, 200, ok([{ ...product.category!, children: [] }]));
  const filters = /^\/categories\/([a-z0-9-]+)\/filters$/.exec(path);
  if (filters) return send(res, 200, ok(categoryFilters(filters[1])));
  if (path === "/sources/status")
    return send(
      res,
      200,
      ok({
        totalSources: 2,
        activeSources: 1,
        healthySources: 1,
        sources: [
          {
            slug: "mock_1",
            name: "Mock Store 1",
            status: "ACTIVE",
            connectorStatus: "ACTIVE",
            statusReason: null,
            isSample: true,
            integrationKind: "MOCK",
            health: "HEALTHY",
            lastHealthCheckAt: null,
          },
          {
            slug: "flipkart",
            name: "Flipkart",
            status: "PENDING_CREDENTIALS",
            connectorStatus: "PENDING_CREDENTIALS",
            statusReason: "Affiliate API token not configured",
            isSample: false,
            integrationKind: "AFFILIATE_FEED",
            health: "UNKNOWN",
            lastHealthCheckAt: null,
          },
        ],
      }),
    );
  if (path === "/products") return send(res, 200, page([product]));
  if (path === `/products/${PRODUCT_ID}`) return send(res, 200, ok(product));
  if (path === `/products/${PRODUCT_ID}/pricing`)
    return send(
      res,
      200,
      ok(productPricing({ stale: url.searchParams.get("includeStale") === "true" })),
    );
  if (path === `/products/${PRODUCT_ID}/history`) {
    const days = url.searchParams.get("days") ?? "90";
    const h = priceHistory();
    const from =
      days === "all"
        ? h.trackingSince!
        : new Date(Date.now() - Number(days) * 86_400_000).toISOString();
    const points = h.points.filter((p) => p.observedAt >= from);
    return send(res, 200, ok({ ...h, from, points }));
  }
  if (path === "/compare")
    return send(
      res,
      200,
      ok({ items: [], recommendations: recommendations("00000000-0000-7000-8000-000000000002") }),
    );

  // ── user-owned (session required) ──
  if (!signedIn(req)) return send(res, 401, err("UNAUTHENTICATED", "Sign in"));
  if (path === "/search" && method === "POST") {
    searchFinished = false;
    return send(res, 202, ok({ ...searchDetail(), status: "PENDING" }));
  }
  if (path === "/search") return send(res, 200, page([]));
  if (path === `/search/${SEARCH_ID}`)
    return send(
      res,
      200,
      ok(
        searchFinished
          ? searchDetail({
              status: "PARTIAL",
              resultCount: 2,
              completedAt: new Date().toISOString(),
              ranking: { mode: "best_value", chosenBy: "ai" },
              summary:
                "Found 2 matching offers. Top pick: Acme Nova 7 5G on Mock Store 1 at ₹24,999.",
              sourceRuns: [
                {
                  source: {
                    id: "30000000-0000-7000-8000-000000000001",
                    slug: "mock_1",
                    name: "Mock Store 1",
                    isSample: true,
                  },
                  status: "SUCCEEDED",
                  resultCount: 1,
                  durationMs: 120,
                  errorCode: null,
                  errorMessage: null,
                },
                {
                  source: {
                    id: "30000000-0000-7000-8000-000000000002",
                    slug: "mock_2",
                    name: "Mock Store 2",
                    isSample: true,
                  },
                  status: "FAILED",
                  resultCount: 0,
                  durationMs: 900,
                  errorCode: "UPSTREAM_ERROR",
                  errorMessage: "Store unavailable",
                },
              ],
            })
          : searchDetail(),
      ),
    );
  if (path === `/search/${SEARCH_ID}/results`)
    return send(
      res,
      200,
      searchFinished
        ? page([
            searchResult(1),
            searchResultVariant(
              2,
              2,
              { ram_gb: 12, storage_gb: 256, color: "midnight black" },
              2_999_900,
            ),
          ])
        : page([]),
    );
  if (path === `/search/${SEARCH_ID}/events`) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const events = [
      { type: "node_started", node: "intent_extractor" },
      { type: "node_finished", node: "intent_extractor" },
      { type: "node_finished", node: "query_validator" },
      { type: "node_finished", node: "search_planner" },
      { type: "node_finished", node: "source_discovery" },
      { type: "node_started", node: "parallel_search" },
      { type: "sources_planned", sources: ["mock_1", "mock_2"], skipped: ["flipkart"] },
      { type: "source_finished", source: "mock_1", status: "SUCCEEDED", resultCount: 1 },
      { type: "source_finished", source: "mock_2", status: "FAILED", resultCount: 0 },
      { type: "node_finished", node: "parallel_search" },
      { type: "node_finished", node: "deduplicate" },
      { type: "node_finished", node: "calculate_discounts" },
      { type: "node_finished", node: "rank_deals" },
    ];
    let i = 0;
    const timer = setInterval(() => {
      const e = events[i++];
      if (e) {
        res.write(`data: ${JSON.stringify({ ...e, at: new Date().toISOString() })}\n\n`);
      } else {
        searchFinished = true;
        res.write(
          `data: ${JSON.stringify({ type: "status", status: "PARTIAL", at: new Date().toISOString() })}\n\n`,
        );
        clearInterval(timer);
        res.end();
      }
    }, 250);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (path === "/watchlists" && method === "GET") return send(res, 200, page([]));
  if (path === "/alerts") return send(res, 200, page([]));
  if (path === "/notifications/unread-count") return send(res, 200, ok({ unread: 2 }));
  // Live stream: 204 tells EventSource not to reconnect (keeps "networkidle" reachable).
  if (path === "/notifications/stream") return void res.writeHead(204).end();
  if (path === "/notifications")
    return send(
      res,
      200,
      page([
        {
          id: "60000000-0000-7000-8000-000000000001",
          type: "TARGET_PRICE_REACHED",
          category: "PRICE_ALERTS",
          critical: false,
          title: "Mock product reached your target on Mock Store 1",
          body: "Sample notification from the E2E mock API.",
          link: "/products/10000000-0000-7000-8000-000000000001",
          data: {},
          readAt: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: "60000000-0000-7000-8000-000000000002",
          type: "NEW_SIGN_IN",
          category: "ACCOUNT",
          critical: true,
          title: "New sign-in to your account",
          body: "Sample security notice from the E2E mock API.",
          link: "/settings/security",
          data: {},
          readAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]),
    );
  if (path === "/users/me/notification-preferences")
    return send(
      res,
      200,
      ok({
        inAppEnabled: true,
        emailEnabled: true,
        pushEnabled: false,
        categories: {
          PRICE_ALERTS: { inApp: true, email: true, push: true },
          SEARCH: { inApp: true, email: false, push: false },
          ACCOUNT: { inApp: true, email: false, push: true },
        },
        quietHours: { start: "22:00", end: "07:00" },
        timezone: "Asia/Kolkata",
        language: "en-IN",
        pushSubscriptions: 0,
      }),
    );
  if (path === "/push/config") return send(res, 200, ok({ publicKey: null }));
  if (path === "/usage")
    return send(
      res,
      200,
      ok({
        plan: "FREE",
        items: [
          {
            key: "searches",
            label: "AI searches today",
            used: 1,
            limit: 20,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          { key: "activeAlerts", label: "Active price alerts", used: 0, limit: 5, resetsAt: null },
          { key: "watchlists", label: "Watchlists", used: 0, limit: 2, resetsAt: null },
          { key: "trackedProducts", label: "Tracked products", used: 0, limit: 25, resetsAt: null },
          {
            key: "exports",
            label: "Exports this month",
            used: 0,
            limit: 0,
            resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ],
        historyDays: 90,
        compareItems: 2,
      }),
    );
  // Sample plans (E2E mock data; real prices come from the API's configurable plan rows).
  if (path === "/billing/plans") return send(res, 200, ok(MOCK_PLANS));
  if (path === "/billing/subscription")
    return send(
      res,
      200,
      ok({
        plan: MOCK_PLANS[0],
        effectivePlan: "FREE",
        status: "ACTIVE",
        interval: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        trialEnd: null,
        graceUntil: null,
        provider: null,
        lastSyncedAt: null,
      }),
    );
  return send(res, 404, err("NOT_FOUND", `E2E mock has no ${method} ${path}`));
});

server.listen(PORT, "127.0.0.1", () => console.warn(`e2e mock API on ${PORT}`));
