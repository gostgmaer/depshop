#!/usr/bin/env node
/**
 * DealMind post-deployment smoke tests (public HTTPS checks). Node >= 22, no deps.
 *
 *   APP_URL=https://app.example API_URL=https://api.example node scripts/smoke-tests/smoke.mjs
 *
 * Optional signed-in flow with a DEDICATED TEST ACCOUNT (never a real user):
 *   SMOKE_EMAIL, SMOKE_PASSWORD  → sign in, submit a search, wait for the
 *   background pipeline (worker + agent) to finish it, read notifications, sign out.
 * SMOKE_INSECURE=1 accepts self-signed certificates (local/staging rehearsal only).
 *
 * Prints one line per check; never prints cookies, tokens or response bodies.
 * Exit code 1 if any check fails.
 */
if (process.env.SMOKE_INSECURE === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const APP = (process.env.APP_URL ?? "").replace(/\/+$/, "");
const API = (process.env.API_URL ?? "").replace(/\/+$/, "");
if (!APP || !API) {
  console.error("APP_URL and API_URL are required");
  process.exit(2);
}
const results = [];
const jar = new Map();

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)${note ? ` — ${note}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function req(url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (url.startsWith(APP) && jar.size)
    headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const res = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    ...init,
    headers,
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v === "" || /max-age=0/i.test(c)) jar.delete(k);
    else jar.set(k, v);
  }
  return res;
}
const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

// ── Public surface ──
await check("web: /healthz", async () => {
  const r = await req(`${APP}/healthz`);
  assert(r.status === 200, `status ${r.status}`);
});
await check("web: login page with security headers", async () => {
  const r = await req(`${APP}/login`);
  assert(r.status === 200, `status ${r.status}`);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert(
    /'nonce-/.test(csp) && csp.includes("frame-ancestors 'none'"),
    "CSP missing or incomplete",
  );
  assert(r.headers.get("x-frame-options") === "DENY", "X-Frame-Options missing");
  if (APP.startsWith("https://"))
    assert(/max-age=\d+/.test(r.headers.get("strict-transport-security") ?? ""), "HSTS missing");
});
// The redirect check needs the plain-HTTP URL: derived for standard ports,
// or given explicitly (SMOKE_HTTP_URL) when a non-standard port is used.
const HTTP_URL =
  process.env.SMOKE_HTTP_URL ??
  (/^https:\/\/[^/:]+$/.test(APP) ? APP.replace(/^https:/, "http:") : "");
if (APP.startsWith("https://") && HTTP_URL) {
  await check("edge: http → https redirect", async () => {
    const r = await fetch(HTTP_URL + "/login", {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    assert([301, 302, 307, 308].includes(r.status), `status ${r.status}`);
    assert((r.headers.get("location") ?? "").startsWith("https://"), "redirect is not to https");
  });
}
await check("api host: /health/live", async () => {
  const r = await req(`${API}/health/live`);
  assert(r.status === 200, `status ${r.status}`);
});
await check("api: catalog categories (same-origin /api)", async () => {
  const r = await req(`${APP}/api/v1/categories/tree`);
  const b = await json(r);
  assert(r.status === 200 && b?.success === true, `status ${r.status}`);
  assert(r.headers.get("x-request-id"), "no x-request-id");
  return `${Array.isArray(b.data) ? b.data.length : 0} top-level categories`;
});
await check("api: marketplace source status (honest readiness)", async () => {
  const r = await req(`${API}/api/v1/sources/status`);
  const b = await json(r);
  assert(r.status === 200 && b?.success === true, `status ${r.status}`);
  const list = Array.isArray(b.data) ? b.data : (b.data?.sources ?? []);
  return `${list.length} sources reported`;
});

// ── Must NOT be reachable from the internet ──
for (const [name, url] of [
  ["api host: /internal not routed", `${API}/internal/v1/categories`],
  ["api host: /metrics not routed", `${API}/metrics`],
  ["api host: /docs not routed", `${API}/docs`],
  ["api host: /ready not routed", `${API}/ready`],
  ["web: proxy path escape refused", `${APP}/api/%2e%2e/internal/v1/categories`],
]) {
  await check(name, async () => {
    const r = await req(url);
    assert(r.status === 404, `status ${r.status} (expected 404)`);
  });
}

// ── Signed-in flow with a dedicated test account ──
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
if (email && password) {
  const csrf = () => jar.get("__Host-dm_csrf") ?? jar.get("dm_csrf") ?? "";
  const write = (method, path, body) =>
    req(`${APP}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: APP, "x-csrf-token": csrf() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  await check("auth: sign in (test account)", async () => {
    await req(`${APP}/api/v1/auth/csrf`);
    const r = await write("POST", "/api/v1/auth/login", { email, password });
    assert(r.status === 200, `status ${r.status}`);
  });
  await check("auth: session resolves (/auth/me)", async () => {
    const r = await req(`${APP}/api/v1/auth/me`);
    assert(r.status === 200, `status ${r.status}`);
  });
  let searchId = null;
  await check("search: submit", async () => {
    const r = await write("POST", "/api/v1/search", {
      query: "smoke test: wireless earbuds under 3000",
    });
    const b = await json(r);
    assert([200, 201, 202].includes(r.status) && b?.data?.id, `status ${r.status}`);
    searchId = b.data.id;
  });
  if (searchId) {
    await check("background: worker + agent finish the search", async () => {
      const deadline = Date.now() + Number(process.env.SMOKE_SEARCH_TIMEOUT_MS ?? 180_000);
      for (;;) {
        const r = await req(`${APP}/api/v1/search/${searchId}`);
        const status = (await json(r))?.data?.status;
        if (["COMPLETED", "PARTIAL", "FAILED", "NEEDS_CLARIFICATION", "CANCELLED"].includes(status))
          return `status ${status}`;
        assert(Date.now() < deadline, `still ${status} after timeout`);
        await new Promise((r2) => setTimeout(r2, 3_000));
      }
    });
  }
  await check("notifications: unread count", async () => {
    const r = await req(`${APP}/api/v1/notifications/unread-count`);
    assert(r.status === 200, `status ${r.status}`);
  });
  await check("auth: sign out", async () => {
    const r = await write("POST", "/api/v1/auth/logout");
    assert([200, 204].includes(r.status), `status ${r.status}`);
  });
} else {
  console.log("SKIP  signed-in flow (set SMOKE_EMAIL/SMOKE_PASSWORD for a dedicated test account)");
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
