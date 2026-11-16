/**
 * Delivery outcomes shared by channel providers. A permanent error is not
 * retried (bad address, gone subscription, rejected content); a transient one
 * is retried with backoff and dead-lettered when attempts run out.
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    /** Push: the subscription no longer exists (HTTP 404/410). */
    readonly gone = false,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/** HTTP status → permanent? (408, 425, 429 and 5xx are transient). */
export const isPermanentStatus = (status: number) =>
  status >= 400 && status < 500 && ![408, 425, 429].includes(status);

/** Error text safe to store: no payloads, capped length. */
export const safeErrorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300);
