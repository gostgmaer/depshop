import { type NextRequest, NextResponse } from "next/server";

/**
 * Exposes the requested path to server layouts (x-pathname) so protected
 * pages can send signed-out visitors to /login?next=<path>. Authentication
 * itself is decided server-side in the layout by asking the API, not here.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/search/:path*",
    "/products/:path*",
    "/categories/:path*",
    "/compare/:path*",
    "/watchlists/:path*",
    "/alerts/:path*",
    "/history/:path*",
    "/notifications/:path*",
    "/settings/:path*",
    "/billing/:path*",
  ],
};
