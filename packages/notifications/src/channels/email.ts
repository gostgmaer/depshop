/**
 * Email provider abstraction. The production provider sends DealMind's own
 * rendered HTML/text through the shared EasyDev notification service
 * (pre-rendered mode); credentials stay in that service, never in DealMind.
 */
import { DeliveryError, isPermanentStatus, safeErrorText } from "../delivery/errors.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key on every retry: the provider sends at most once. */
  idempotencyKey: string;
  /** Non-sensitive identifiers for the provider's log. */
  metadata: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId: string | null }>;
}

/** The subset of `@easydev_org/notification-sdk`'s client this provider uses. */
export interface SharedNotificationClient {
  sendEmail(
    payload: {
      to: string;
      subject?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    } & Record<string, unknown>,
  ): Promise<{ success?: boolean; message?: string; data?: unknown; requestId?: string }>;
}

export class SharedServiceEmailProvider implements EmailProvider {
  readonly name = "easydev-notification-service";

  constructor(private readonly client: SharedNotificationClient) {}

  async send(m: EmailMessage): Promise<{ messageId: string | null }> {
    let res: Awaited<ReturnType<SharedNotificationClient["sendEmail"]>>;
    try {
      res = await this.client.sendEmail({
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        idempotencyKey: m.idempotencyKey,
        metadata: m.metadata,
      });
    } catch (err) {
      const status = (err as { statusCode?: unknown }).statusCode;
      const name = (err as { name?: unknown }).name;
      if (typeof status === "number")
        throw new DeliveryError(
          `Notification service ${status}: ${safeErrorText(err)}`,
          isPermanentStatus(status),
        );
      // Client-side validation can't succeed on retry; timeouts/network can.
      throw new DeliveryError(safeErrorText(err), name === "NotificationValidationError");
    }
    if (res.success === false)
      throw new DeliveryError(res.message ?? "Notification service rejected the email", false);
    const id = (res as { requestId?: unknown }).requestId;
    return { messageId: typeof id === "string" ? id : null };
  }
}
