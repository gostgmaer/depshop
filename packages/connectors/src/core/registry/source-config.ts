/**
 * Connector metadata lives in the existing ShoppingSource table. The framework
 * reads it through `SourceConfigProvider` and reports health/success through
 * `SourceStatusStore`, so the core stays testable without a database.
 */
import type { PrismaClient } from "@dealmind/db";

export type SourceAdminStatus =
  "ACTIVE" | "PENDING_CREDENTIALS" | "PENDING_APPROVAL" | "DISABLED" | "MAINTENANCE";
export type SourceHealthValue = "UNKNOWN" | "HEALTHY" | "DEGRADED" | "DOWN";

export interface SourceConfig {
  id: string;
  slug: string;
  name: string;
  status: SourceAdminStatus;
  isSample: boolean;
  timeoutMs: number;
  rateLimitPerMinute: number;
  maxRetries: number;
  cacheTtlSeconds: number;
  circuitFailureThreshold: number;
  circuitOpenSeconds: number;
  health: SourceHealthValue;
}

export interface SourceConfigProvider {
  list(): Promise<SourceConfig[]>;
}

export interface SourceStatusStore {
  recordHealth(
    slug: string,
    health: SourceHealthValue,
    error: string | null,
    checkedAt: Date,
  ): Promise<void>;
  recordSuccess(slug: string, at: Date): Promise<void>;
}

const SELECT = {
  id: true,
  slug: true,
  name: true,
  status: true,
  isSample: true,
  timeoutMs: true,
  rateLimitPerMinute: true,
  maxRetries: true,
  cacheTtlSeconds: true,
  circuitFailureThreshold: true,
  circuitOpenSeconds: true,
  health: true,
} as const;

/** Reads source configuration from PostgreSQL, briefly cached in memory. */
export class PrismaSourceConfigProvider implements SourceConfigProvider {
  private cached: { at: number; rows: SourceConfig[] } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs = 5_000,
  ) {}

  async list(): Promise<SourceConfig[]> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.rows;
    const rows = await this.prisma.shoppingSource.findMany({
      select: SELECT,
      orderBy: { slug: "asc" },
    });
    this.cached = { at: Date.now(), rows };
    return rows;
  }
}

export class PrismaSourceStatusStore implements SourceStatusStore {
  constructor(private readonly prisma: PrismaClient) {}

  async recordHealth(
    slug: string,
    health: SourceHealthValue,
    error: string | null,
    checkedAt: Date,
  ) {
    await this.prisma.shoppingSource.updateMany({
      where: { slug },
      data: { health, lastHealthError: error?.slice(0, 500) ?? null, lastHealthCheckAt: checkedAt },
    });
  }

  async recordSuccess(slug: string, at: Date) {
    await this.prisma.shoppingSource.updateMany({ where: { slug }, data: { lastSuccessAt: at } });
  }
}

/**
 * The status reported to users/admins, combining admin status and runtime health:
 *   ACTIVE | DEGRADED | FAILED | PENDING_CREDENTIALS | PENDING_APPROVAL | DISABLED
 */
export type EffectiveSourceStatus =
  "ACTIVE" | "PENDING_CREDENTIALS" | "PENDING_APPROVAL" | "DISABLED" | "DEGRADED" | "FAILED";

export function effectiveStatus(
  status: SourceAdminStatus,
  health: SourceHealthValue,
): EffectiveSourceStatus {
  if (status === "PENDING_CREDENTIALS" || status === "PENDING_APPROVAL") return status;
  if (status !== "ACTIVE") return "DISABLED"; // DISABLED, MAINTENANCE
  if (health === "DOWN") return "FAILED";
  if (health === "DEGRADED") return "DEGRADED";
  return "ACTIVE";
}
