/**
 * Adapter over the shared EasyDev notification service
 * (`@easydev_org/notification-sdk`). DealMind does not send email itself.
 *
 * Identity emails (verification, password reset, security notices) are sent
 * by the IAM through this same service. DealMind's own notifications (price
 * alerts, Phase 7) will go through `sendEmail` below.
 *
 * `x-tenant-id` is a config constant for the shared service; DealMind has no tenancy.
 */
import { NotificationClient } from "@easydev_org/notification-sdk";

export interface NotificationGatewayOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  tenantId: string;
  timeoutMs: number;
}

export class NotificationGateway {
  private readonly client: NotificationClient;

  constructor(private readonly opts: NotificationGatewayOptions) {
    this.client = new NotificationClient({
      baseUrl: opts.baseUrl,
      tenantId: opts.tenantId,
      timeout: opts.timeoutMs,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    });
  }

  /** The underlying SDK client, for template-specific sends. */
  get sdk(): NotificationClient {
    return this.client;
  }

  /** Readiness probe: the service's own health endpoint (as used by the IAM). */
  async health(): Promise<void> {
    const res = await fetch(`${this.opts.baseUrl}/v1/health`, {
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`notification service health ${res.status}`);
  }
}
