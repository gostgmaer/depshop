/**
 * Verifies the shared payment service's outbound webhook signature:
 * `x-easydev-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Constant-time comparison; timestamps outside the tolerance are rejected so
 * a captured request can't be replayed later (duplicates within the window
 * are absorbed by the unique event id).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const EASYDEV_SIGNATURE_HEADER = "x-easydev-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureCheck =
  { ok: true } | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export function signEasyDevPayload(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyEasyDevSignature(
  secret: string,
  header: string | undefined,
  rawBody: string,
  now = new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): SignatureCheck {
  if (!header) return { ok: false, reason: "missing" };
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1 ?? "";
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "malformed" };
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds)
    return { ok: false, reason: "expired" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/** Event body (thin: a hint; the receiver re-fetches authoritative state). */
export const easyDevWebhookEvent = z.object({
  id: z.string().min(1).max(100),
  type: z.string().min(1).max(100),
  createdAt: z.string(),
  tenantId: z.string(),
  applicationId: z.string(),
  data: z.object({ customerId: z.string().min(1).max(100) }).passthrough(),
});
export type EasyDevWebhookEvent = z.infer<typeof easyDevWebhookEvent>;
