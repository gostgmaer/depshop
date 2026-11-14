/**
 * Adapter over the shared EasyDev file-upload service
 * (`@easydev_org/file-upload-sdk`). DealMind stores no files itself.
 *
 * The service trusts HMAC-signed identity headers (X-User-Id, X-User-Role,
 * X-Tenant-Id, X-Gateway-HMAC). The SDK signs them with
 * FILE_SERVICE_HMAC_SECRET; `forUser` builds that identity ONLY from a
 * server-verified DealMind principal, never from request input.
 *
 * `tenantId` is a config constant for the shared service; DealMind has no tenancy.
 */
import { FileUploadClient } from "@easydev_org/file-upload-sdk";
import type { UserRole } from "@dealmind/shared";

export interface FileGatewayOptions {
  baseUrl: string;
  hmacSecret?: string | undefined;
  tenantId: string;
}

export class FileGateway {
  private readonly client: FileUploadClient;

  constructor(private readonly opts: FileGatewayOptions) {
    this.client = new FileUploadClient({
      baseUrl: opts.baseUrl,
      tenantId: opts.tenantId,
      userId: "dealmind-api",
      userRole: "user",
      ...(opts.hmacSecret ? { gatewaySecret: opts.hmacSecret } : {}),
    });
  }

  /** A client acting as an authenticated DealMind user. */
  forUser(principal: { userId: string; role: UserRole }): FileUploadClient {
    return this.client.asUser({
      userId: principal.userId,
      userRole: principal.role === "ADMIN" ? "admin" : "user",
      tenantId: this.opts.tenantId,
    });
  }

  async health(): Promise<void> {
    await this.client.getHealth();
  }
}
