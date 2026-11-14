/**
 * Periodic connector health checks. Results are persisted on ShoppingSource
 * (`health`, `lastHealthCheckAt`, `lastHealthError`, `lastSuccessAt`) and
 * surface through the API as the effective status (ACTIVE/DEGRADED/FAILED…).
 *
 * A connector that isn't configured is reported without any network call:
 * a source an admin set ACTIVE but whose credentials are missing shows as
 * FAILED with the reason, instead of silently returning nothing.
 */
import type { ConnectorRegistry } from "../registry/registry.js";
import type {
  SourceConfigProvider,
  SourceHealthValue,
  SourceStatusStore,
} from "../registry/source-config.js";
import { connectorHealthSchema } from "../types/schemas.js";

export interface HealthReport {
  sourceId: string;
  health: SourceHealthValue;
  message: string | null;
  latencyMs: number | null;
  checked: boolean;
}

export class HealthMonitor {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly sources: SourceConfigProvider,
    private readonly store: SourceStatusStore,
    private readonly options: { timeoutMs?: number; now?: () => number } = {},
  ) {}

  async checkAll(): Promise<HealthReport[]> {
    const rows = await this.sources.list();
    const reports = await Promise.allSettled(
      rows
        .filter((s) => this.registry.get(s.slug))
        .map((s) => this.check(s.slug, s.status === "ACTIVE")),
    );
    return reports.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }

  async check(sourceId: string, active: boolean): Promise<HealthReport> {
    const now = this.options.now ?? Date.now;
    const connector = this.registry.get(sourceId);
    if (!connector) throw new Error(`No connector for ${sourceId}`);
    const readiness = connector.getReadiness();
    let report: HealthReport;
    if (readiness.state !== "READY") {
      const message =
        readiness.state === "PENDING_CREDENTIALS"
          ? `Credentials not configured: ${readiness.missing.join(", ")}`
          : readiness.reason;
      // Only an ACTIVE source is "down" for being unconfigured; otherwise the
      // pending admin status already explains it.
      report = {
        sourceId,
        health: active ? "DOWN" : "UNKNOWN",
        message,
        latencyMs: null,
        checked: false,
      };
    } else {
      const started = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
      try {
        const h = connectorHealthSchema.parse(
          await connector.getHealth({ signal: controller.signal }),
        );
        report = {
          sourceId,
          health: h.status,
          message: h.message ?? null,
          latencyMs: now() - started,
          checked: true,
        };
      } catch (err) {
        report = {
          sourceId,
          health: "DOWN",
          message: controller.signal.aborted
            ? "Health check timed out"
            : (err as Error).message.slice(0, 300),
          latencyMs: now() - started,
          checked: true,
        };
      } finally {
        clearTimeout(timer);
      }
    }
    const at = new Date(now());
    await this.store.recordHealth(
      sourceId,
      report.health,
      report.health === "HEALTHY" ? null : report.message,
      at,
    );
    if (report.health === "HEALTHY") await this.store.recordSuccess(sourceId, at);
    return report;
  }
}
