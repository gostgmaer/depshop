/**
 * Web Push provider (RFC 8030 + VAPID via the `web-push` library). VAPID keys
 * come from the environment; the payload is encrypted for the subscription
 * (aes128gcm) so the push service can't read it.
 */
import { isAllowedPushEndpoint } from "@dealmind/shared";
import webpush from "web-push";
import { DeliveryError, isPermanentStatus, safeErrorText } from "../delivery/errors.js";
import type { PushPayload } from "../templates/render.js";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushProvider {
  readonly publicKey: string;
  send(target: PushTarget, payload: PushPayload): Promise<void>;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** "mailto:…" or an https URL identifying the sender to push services. */
  subject: string;
}

export function assertVapid(c: VapidConfig): void {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(c.publicKey))
    throw new Error("VAPID_PUBLIC_KEY must be a base64url P-256 public key");
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(c.privateKey))
    throw new Error("VAPID_PRIVATE_KEY must be a base64url P-256 private key");
  if (!/^(mailto:|https:\/\/)/.test(c.subject))
    throw new Error("VAPID_SUBJECT must start with mailto: or https://");
}

export class WebPushProvider implements PushProvider {
  readonly publicKey: string;

  constructor(
    private readonly vapid: VapidConfig,
    private readonly opts: { timeoutMs?: number; ttlSeconds?: number } = {},
  ) {
    assertVapid(vapid);
    this.publicKey = vapid.publicKey;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<void> {
    // Re-checked at send time (covers rows stored before the allowlist): never
    // POST to an internal or arbitrary host. Treated as "gone" (permanent).
    if (!isAllowedPushEndpoint(target.endpoint))
      throw new DeliveryError("Push endpoint host is not an allowed push service", true, true);
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: this.vapid,
          TTL: this.opts.ttlSeconds ?? 24 * 3600,
          timeout: this.opts.timeoutMs ?? 10_000,
          urgency: "normal",
          contentEncoding: "aes128gcm",
        },
      );
    } catch (err) {
      const status = (err as { statusCode?: unknown }).statusCode;
      if (typeof status === "number") {
        const gone = status === 404 || status === 410;
        throw new DeliveryError(
          `Push service ${status}${gone ? " (subscription gone)" : ""}`,
          gone || isPermanentStatus(status),
          gone,
        );
      }
      throw new DeliveryError(safeErrorText(err), false);
    }
  }
}

/** Generates a VAPID key pair (for `pnpm notifications:vapid`; never commit the private key). */
export const generateVapidKeys = () => webpush.generateVAPIDKeys();
