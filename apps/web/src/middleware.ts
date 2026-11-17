import { type NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy } from "@/lib/csp";

/**
 * Runs for every page request:
 * - a fresh CSP nonce per request (Next.js applies it to its own scripts;
 *   the root layout reads it, which keeps pages dynamically rendered);
 * - exposes the requested path to server layouts (x-pathname) so protected
 *   pages can send signed-out visitors to /login?next=<path>. Authentication
 *   itself is decided server-side in the layout by asking the API, not here.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV !== "production");
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Pages only: not the API proxy (JSON, has its own headers), static assets or the service worker.
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|icon.svg|sw.js|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
