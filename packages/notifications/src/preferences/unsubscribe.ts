/**
 * Signed one-click unsubscribe tokens for email footers. The token names the
 * user and category; it can only turn that category's email off. HMAC-SHA256
 * with a server secret (NOTIFICATION_TOKEN_SECRET), compared in constant time.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { NOTIFICATION_CATEGORIES, type NotificationCategoryValue } from "@dealmind/shared";

const VERSION = 1;
export const UNSUBSCRIBE_TTL_DAYS = 365;

interface Payload {
  v: number;
  u: string;
  c: NotificationCategoryValue;
  e: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (secret: string, body: string) =>
  createHmac("sha256", secret).update(`unsubscribe.${body}`).digest();

function assertSecret(secret: string) {
  if (!secret || secret.length < 32)
    throw new Error("NOTIFICATION_TOKEN_SECRET must be at least 32 characters");
}

export function createUnsubscribeToken(
  secret: string,
  userId: string,
  category: NotificationCategoryValue,
  now = new Date(),
): string {
  assertSecret(secret);
  const payload: Payload = {
    v: VERSION,
    u: userId,
    c: category,
    e: Math.floor(now.getTime() / 1000) + UNSUBSCRIBE_TTL_DAYS * 86_400,
  };
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(sign(secret, body))}`;
}

export type UnsubscribeVerification =
  | { ok: true; userId: string; category: NotificationCategoryValue }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

export function verifyUnsubscribeToken(
  secret: string,
  token: string,
  now = new Date(),
): UnsubscribeVerification {
  assertSecret(secret);
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  const expected = sign(secret, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "signature" };
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    p.v !== VERSION ||
    typeof p.u !== "string" ||
    !NOTIFICATION_CATEGORIES.includes(p.c) ||
    typeof p.e !== "number"
  )
    return { ok: false, reason: "malformed" };
  if (p.e * 1000 < now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, userId: p.u, category: p.c };
}
