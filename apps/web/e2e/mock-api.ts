/**
 * E2E TEST SERVER ONLY — a stand-in for the Fastify API so Playwright can run
 * the production Next.js build (server components included) without a
 * database. Responses use the contract-checked fixtures from
 * src/test/fixtures.ts (fictional "Acme" products, "Mock Store" sources).
 *
 * Run: node e2e/mock-api.ts   (Node ≥ 23 strips TypeScript types natively)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { productPricing, searchDetail, searchResult } from "../src/test/fixtures.ts";

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

const product = {
  id: PRODUCT_ID,
  name: "Acme Nova 7 5G",
  brand: "Acme",
  modelNumber: null,
  imageUrl: null,
  category: {
    id: "70000000-0000-7000-8000-000000000001",
    slug: "smartphones",
    name: "Smartphones",
    description: null,
    imageUrl: null,
    parentId: null,
  },
  launchDate: null,
  lowestPricePaise: 2_453_900,
  offerCount: 2,
  inStock: true,
  sampleData: false,
  description: "Fictional E2E test product.",
  manufacturer: null,
  gtin: null,
  ean: null,
  upc: null,
  specifications: { Display: "6.6 inch" },
  variants: [
    {
      id: "20000000-0000-7000-8000-000000000001",
      variantKey: "ram=8|storage=128",
      attributes: { ram_gb: 8, storage_gb: 128, color: "midnight black" },
      sku: null,
      gtin: null,
    },
  ],
};

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
    return send(res, 200, ok([{ ...product.category, children: [] }]));
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
  if (path === `/products/${PRODUCT_ID}/pricing`) return send(res, 200, ok(productPricing()));
  if (path === `/products/${PRODUCT_ID}/history`) {
    // Deterministic synthetic series (fictional): two mock stores over 30 days.
    const day = 86_400_000;
    const to = Date.now();
    const points = [1, 2].flatMap((n) =>
      Array.from({ length: 10 }, (_, i) => ({
        offerId: `00000000-0000-7000-8000-00000000000${n}`,
        variantId: "20000000-0000-7000-8000-000000000001",
        sourceSlug: `mock_${n}`,
        mrpPaise: 2_999_900,
        sellingPricePaise: 2_699_900 - i * 20_000 - (n - 1) * 50_000,
        shippingPaise: 0,
        stockStatus: "IN_STOCK",
        observedAt: new Date(to - (30 - i * 3) * day).toISOString(),
      })),
    );
    const prices = points.map((p) => p.sellingPricePaise);
    return send(res, 200, ok({ productId: PRODUCT_ID, from: new Date(to - 30 * day).toISOString(), to: new Date(to).toISOString(), points, lowestPricePaise: Math.min(...prices), highestPricePaise: Math.max(...prices) }));
  }

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
              resultCount: 1,
              summary:
                "Found 1 matching offer. Top pick: Acme Nova 7 5G on Mock Store 1 at ₹24,999.",
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
    return send(res, 200, searchFinished ? page([searchResult()]) : page([]));
  if (path === `/search/${SEARCH_ID}/events`) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const events = [
      { type: "node_started", node: "parallel_search" },
      { type: "sources_planned", sources: ["mock_1", "mock_2"], skipped: ["flipkart"] },
      { type: "source_finished", source: "mock_1", status: "SUCCEEDED", resultCount: 1 },
      { type: "source_finished", source: "mock_2", status: "FAILED", resultCount: 0 },
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
  if (path === "/notifications") return send(res, 200, page([]));
  if (path === "/subscriptions/me/usage")
    return send(
      res,
      200,
      ok({
        plan: "FREE",
        searchesToday: { used: 1, limit: 10, resetsAt: new Date().toISOString() },
        activeAlerts: { used: 0, limit: 3 },
        watchlists: { used: 0, limit: 2 },
      }),
    );
  return send(res, 404, err("NOT_FOUND", `E2E mock has no ${method} ${path}`));
});

server.listen(PORT, "127.0.0.1", () => console.warn(`e2e mock API on ${PORT}`));
