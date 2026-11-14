import type { CookieSerializeOptions } from "@fastify/cookie";

/**
 * Cookie policy.
 *
 * Over HTTPS the `__Host-` prefix is used: browsers then require Secure,
 * Path=/ and no Domain, so the cookie cannot be set or overridden by a
 * sibling subdomain. Plain-HTTP local development cannot use the prefix.
 */
export interface CookieNames {
  session: string;
  csrf: string;
}

export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { session: "__Host-dm_session", csrf: "__Host-dm_csrf" }
    : { session: "dm_session", csrf: "dm_csrf" };
}

/** Session cookie: HttpOnly so scripts can never read it. */
export function sessionCookieOptions(
  secure: boolean,
  maxAgeSeconds: number,
): CookieSerializeOptions {
  return { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: maxAgeSeconds };
}

/** CSRF cookie: readable by the app's own scripts (double-submit pattern). */
export function csrfCookieOptions(secure: boolean): CookieSerializeOptions {
  return { httpOnly: false, secure, sameSite: "strict", path: "/" };
}
