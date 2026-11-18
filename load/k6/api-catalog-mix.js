/**
 * DealMind API — catalog and search load (Phase 21).
 *
 * Product search, product detail, offer comparison, pricing, price history and
 * multi-product compare against the LABELLED SAMPLE CATALOG ("DealMind Sample
 * Store", fictional prices) seeded by the load harness; plus search submission
 * (POST /search: validation, entitlement check, enqueue) for a signed-in user.
 *
 *   BASE_URL, SESSION, CSRF  (from the harness)
 *   PRODUCTS  comma list of productId:variantId pairs
 *   VUS, DURATION
 *
 * Never point this at live marketplaces or production user accounts.
 */
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://host.docker.internal:4610";
const SESSION = __ENV.SESSION || "";
const CSRF = __ENV.CSRF || "";
const PAIRS = (__ENV.PRODUCTS || "")
  .split(",")
  .filter(Boolean)
  .map((p) => p.split(":"));
const QUERIES = ["iphone", "galaxy", "pixel", "airpods", "macbook", "redmi", "oneplus", "boat"];

export const options = {
  scenarios: {
    browse: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: Number(__ENV.VUS || 25) },
        { duration: __ENV.DURATION || "40s", target: Number(__ENV.VUS || 25) },
        { duration: "5s", target: 0 },
      ],
      exec: "browse",
    },
    submit: {
      // Search submissions: 2 per 5 s (24/min) stays under the API's per-client
      // limit (30/min) and the plan quota, so this measures latency, not throttling.
      executor: "constant-arrival-rate",
      rate: Number(__ENV.SUBMIT_RATE || 2),
      timeUnit: "5s",
      duration: __ENV.DURATION || "40s",
      startTime: "10s",
      preAllocatedVUs: 5,
      exec: "submit",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:product_search}": ["p(95)<500"],
    "http_req_duration{endpoint:category_list}": ["p(95)<500"],
    "http_req_duration{endpoint:product_detail}": ["p(95)<500"],
    "http_req_duration{endpoint:offers}": ["p(95)<500"],
    "http_req_duration{endpoint:pricing}": ["p(95)<500"],
    "http_req_duration{endpoint:price_history}": ["p(95)<500"],
    "http_req_duration{endpoint:compare}": ["p(95)<800"],
    "http_req_duration{endpoint:search_submit}": ["p(95)<800"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const headers = { cookie: `dm_session=${SESSION}; dm_csrf=${CSRF}`, accept: "application/json" };
function get(endpoint, path) {
  const r = http.get(`${BASE}${path}`, { headers, tags: { endpoint } });
  check(r, { [`${endpoint} 200`]: (x) => x.status === 200 });
}

export function browse() {
  const [pid, vid] = pick(PAIRS);
  const roll = Math.random();
  if (roll < 0.2) get("product_search", `/api/v1/products?q=${pick(QUERIES)}&page=1&pageSize=20`);
  else if (roll < 0.3)
    get("category_list", "/api/v1/products?category=smartphones&page=1&pageSize=20");
  else if (roll < 0.5) get("product_detail", `/api/v1/products/${pid}`);
  else if (roll < 0.65) get("offers", `/api/v1/products/${pid}/offers`);
  else if (roll < 0.75) get("pricing", `/api/v1/products/${pid}/pricing`);
  else if (roll < 0.9)
    get("price_history", `/api/v1/products/${pid}/history?days=90&variantId=${vid}`);
  else {
    const [p2, v2] = pick(PAIRS);
    get("compare", `/api/v1/compare?items=${pid}:${vid},${p2}:${v2}`);
  }
}

export function submit() {
  const r = http.post(
    `${BASE}/api/v1/search`,
    JSON.stringify({
      query: `${pick(QUERIES)} under ${20000 + Math.floor(Math.random() * 50) * 1000}`,
    }),
    {
      headers: {
        ...headers,
        "content-type": "application/json",
        "x-csrf-token": CSRF,
        origin: "http://localhost:3000",
      },
      tags: { endpoint: "search_submit" },
    },
  );
  check(r, { "search_submit 202": (x) => x.status === 202 });
}
