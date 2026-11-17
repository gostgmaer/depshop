/**
 * Same-origin proxy: the browser talks only to the web origin, and this
 * handler forwards /api/* to the Fastify API. Session cookies therefore stay
 * first-party (no third-party cookies, no credentialed CORS).
 *
 * Only an allow-list of headers is forwarded. Set-Cookie headers from the API
 * are passed through unchanged (HttpOnly/SameSite/Secure are set by the API).
 */
import type { NextRequest } from "next/server";
import { trustedClientIp } from "@/lib/client-ip";

const API_URL = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";
/** Reverse proxies in front of Next.js that set X-Forwarded-For (0 = none, dev only). */
const TRUSTED_PROXY_COUNT = Number(process.env.TRUSTED_PROXY_COUNT ?? "0");

// X-Forwarded-For / X-Real-IP are deliberately NOT copied from the client:
// they are attacker-controlled. See trustedClientIp().
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "cookie",
  "origin",
  "sec-fetch-site",
  "user-agent",
  "x-csrf-token",
];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "location",
  "referrer-policy",
  "x-robots-tag",
  "cache-control",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
];

type Context = { params: Promise<{ path: string[] }> };

/** Same limit as the API (Fastify bodyLimit): refuse before buffering more. */
const MAX_BODY_BYTES = 1_048_576;

/** Reads at most MAX_BODY_BYTES (+1 to detect overflow); null = too large. */
async function readBody(request: NextRequest): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

async function proxy(request: NextRequest, { params }: Context): Promise<Response> {
  const { path } = await params;
  // encodeURIComponent leaves "." and ".." intact and URL() would resolve them,
  // escaping /api (e.g. to /internal or /webhooks). Refuse dot/empty segments
  // and verify the final path is still under /api/.
  if (path.some((s) => s === "" || s === "." || s === ".."))
    return Response.json(
      { success: false, error: { code: "NOT_FOUND", message: "Not found." } },
      { status: 404 },
    );
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, API_URL);
  if (!target.pathname.startsWith("/api/"))
    return Response.json(
      { success: false, error: { code: "NOT_FOUND", message: "Not found." } },
      { status: 404 },
    );
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const clientIp = trustedClientIp(request.headers.get("x-forwarded-for"), TRUSTED_PROXY_COUNT);
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  // Correlation id for API logs (generated here: never taken from the browser).
  headers.set("x-request-id", crypto.randomUUID());

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const body = hasBody ? await readBody(request) : undefined;
  if (body === null)
    return Response.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Request body is too large." } },
      { status: 413 },
    );
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: { code: "SOURCE_UNAVAILABLE", message: "The service is temporarily unavailable." } },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append("set-cookie", cookie);

  // Server-Sent Events (search progress) are streamed through, never buffered.
  if (upstream.headers.get("content-type")?.startsWith("text/event-stream") && upstream.body) {
    responseHeaders.set("cache-control", "no-cache, no-transform");
    responseHeaders.set("x-accel-buffering", "no");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  }
  const out =
    upstream.status === 204 || request.method === "HEAD" ? null : await upstream.arrayBuffer();
  return new Response(out, { status: upstream.status, headers: responseHeaders });
}

export const dynamic = "force-dynamic";
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
