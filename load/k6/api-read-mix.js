/**
 * DealMind API — realistic signed-in read mix (Phase 7.1 load test).
 *
 *   BASE_URL   API origin (default http://host.docker.internal:4610)
 *   SESSION    value of the dm_session cookie of a test user
 *   VUS, DURATION
 *
 * Weights approximate a shopper session: who am I, catalog browsing, my
 * search history, my notifications and watchlists, plus readiness probes.
 * Writes (search creation) are excluded: they enqueue agent work and are
 * measured separately (search/agent timings come from the worker metrics).
 *
 * Run against a TEST or STAGING environment only, never production users.
 */
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://host.docker.internal:4610";
const SESSION = __ENV.SESSION || "";

export const options = {
  scenarios: {
    shoppers: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: Number(__ENV.VUS || 25) },
        { duration: __ENV.DURATION || "40s", target: Number(__ENV.VUS || 25) },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:read}": ["p(95)<300"],
    // Per-endpoint budgets (also makes k6 report each endpoint separately).
    "http_req_duration{endpoint:auth_me}": ["p(95)<300"],
    "http_req_duration{endpoint:categories}": ["p(95)<300"],
    "http_req_duration{endpoint:sources}": ["p(95)<300"],
    "http_req_duration{endpoint:search_history}": ["p(95)<300"],
    "http_req_duration{endpoint:notifications}": ["p(95)<300"],
    "http_req_duration{endpoint:unread}": ["p(95)<300"],
    "http_req_duration{endpoint:watchlists}": ["p(95)<300"],
    "http_req_duration{endpoint:usage}": ["p(95)<300"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const ROUTES = [
  ["auth_me", "/api/v1/auth/me", 3],
  ["categories", "/api/v1/categories/tree", 3],
  ["sources", "/api/v1/sources/status", 1],
  ["search_history", "/api/v1/search?page=1&pageSize=20", 2],
  ["notifications", "/api/v1/notifications?page=1&pageSize=20", 2],
  ["unread", "/api/v1/notifications/unread-count", 2],
  ["watchlists", "/api/v1/watchlists", 1],
  ["usage", "/api/v1/usage", 1],
];
const BAG = ROUTES.flatMap(([name, path, w]) => Array(w).fill([name, path]));

export default function () {
  const [name, path] = BAG[Math.floor(Math.random() * BAG.length)];
  const res = http.get(`${BASE}${path}`, {
    headers: { cookie: `dm_session=${SESSION}`, accept: "application/json" },
    tags: { kind: "read", endpoint: name },
  });
  check(res, { "status 200": (r) => r.status === 200 });
}
