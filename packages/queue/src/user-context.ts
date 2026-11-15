/**
 * Signed user context passed worker → Python agent → internal API. It proves
 * which authenticated user a job belongs to; nobody downstream trusts a bare
 * user_id. Format (also implemented in apps/agent/app/utils/user_context.py):
 *   base64url(JSON {userId, searchId, executionId, exp}) "." base64url(HMAC-SHA256(secret, part1))
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface UserContext {
  userId: string;
  searchId: string;
  executionId: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export function signUserContext(ctx: UserContext, secret: string): string {
  const body = Buffer.from(JSON.stringify(ctx)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyUserContext(
  token: string,
  secret: string,
  nowSeconds = Date.now() / 1000,
): UserContext | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const ctx = JSON.parse(Buffer.from(body, "base64url").toString()) as Partial<UserContext>;
    if (
      typeof ctx.userId !== "string" ||
      typeof ctx.searchId !== "string" ||
      typeof ctx.executionId !== "string" ||
      typeof ctx.exp !== "number" ||
      ctx.exp < nowSeconds
    ) {
      return null;
    }
    return ctx as UserContext;
  } catch {
    return null;
  }
}
