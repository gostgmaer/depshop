import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed double-submit CSRF tokens.
 *
 * The token is `<nonce>.<hmac(secret, nonce)>`. It is set in a readable
 * (non-HttpOnly) cookie; the browser app copies it into the `x-csrf-token`
 * header. A cross-site attacker can neither read the cookie nor set custom
 * headers on a credentialed cross-origin request, and cannot forge a valid
 * signature even if they manage to plant a cookie.
 */
export class CsrfTokens {
  constructor(private readonly secret: string) {}

  issue(): string {
    const nonce = randomBytes(24).toString("base64url");
    return `${nonce}.${this.sign(nonce)}`;
  }

  /** True only if the header equals the cookie and the cookie is correctly signed. */
  verify(cookieValue: string | undefined, headerValue: string | undefined): boolean {
    if (!cookieValue || !headerValue) return false;
    if (!safeEqual(cookieValue, headerValue)) return false;
    const [nonce, signature, extra] = cookieValue.split(".");
    if (!nonce || !signature || extra !== undefined) return false;
    return safeEqual(signature, this.sign(nonce));
  }

  private sign(nonce: string): string {
    return createHmac("sha256", this.secret).update(`csrf:${nonce}`).digest("base64url");
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
