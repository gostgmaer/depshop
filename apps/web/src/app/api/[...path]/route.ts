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
  "location",
  "referrer-policy",
  "x-robots-tag",
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
];

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, { params }: Context): Promise<Response> {
  const { path } = await params;
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, API_URL);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const clientIp = trustedClientIp(request.headers.get("x-forwarded-for"), TRUSTED_PROXY_COUNT);
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
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
  const body =
    upstream.status === 204 || request.method === "HEAD" ? null : await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

export const dynamic = "force-dynamic";
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
