/**
 * Dynamic connector registry. Connectors register by id (= source slug);
 * which ones take part in a search is decided per request from the
 * ShoppingSource configuration, so enabling a marketplace is a data change,
 * not a search-engine change.
 */
import type { ShoppingConnector } from "../interfaces/connector.js";
import type { ConnectorCapabilities, ValidSearchRequest } from "../types/schemas.js";
import type { SourceConfig } from "./source-config.js";

export type SkipReason =
  | "SOURCE_NOT_ACTIVE"
  | "NO_CONNECTOR"
  | "CONNECTOR_DISABLED"
  | "NOT_CONFIGURED"
  | "PENDING_APPROVAL"
  | "NOT_SUPPORTED"
  | "NO_SEARCH_CAPABILITY"
  | "CATEGORY_NOT_SUPPORTED"
  | "NOT_REQUESTED"
  | "MOCK_NOT_ALLOWED";

export interface EligibleSource {
  connector: ShoppingConnector;
  source: SourceConfig;
}

export interface SkippedSource {
  source: SourceConfig;
  reason: SkipReason;
  detail?: string;
}

export interface EligibilityOptions {
  /** Restrict to these source slugs (user filter). */
  only?: string[];
  /** Mock connectors may only run when explicitly allowed (never in production). */
  allowMocks?: boolean;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, ShoppingConnector>();
  /** Process-level kill switches (in addition to ShoppingSource.status). */
  private readonly disabled = new Set<string>();

  register(connector: ShoppingConnector): this {
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(connector.id)) {
      throw new Error(`Invalid connector id "${connector.id}"`);
    }
    if (this.connectors.has(connector.id))
      throw new Error(`Connector "${connector.id}" is already registered`);
    this.connectors.set(connector.id, connector);
    return this;
  }

  unregister(id: string): boolean {
    this.disabled.delete(id);
    return this.connectors.delete(id);
  }

  get(id: string): ShoppingConnector | undefined {
    return this.connectors.get(id);
  }

  list(): ShoppingConnector[] {
    return [...this.connectors.values()];
  }

  setEnabled(id: string, enabled: boolean): void {
    if (!this.connectors.has(id)) throw new Error(`Unknown connector "${id}"`);
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
  }

  isEnabled(id: string): boolean {
    return this.connectors.has(id) && !this.disabled.has(id);
  }

  byCapability(predicate: (c: ConnectorCapabilities) => boolean): ShoppingConnector[] {
    return this.list().filter((c) => predicate(c.getCapabilities()));
  }

  /**
   * Splits sources into those that will be searched and those skipped (with
   * the reason, so every source's outcome can be reported honestly).
   */
  eligible(
    sources: SourceConfig[],
    request: ValidSearchRequest,
    options: EligibilityOptions = {},
  ): { eligible: EligibleSource[]; skipped: SkippedSource[] } {
    const eligible: EligibleSource[] = [];
    const skipped: SkippedSource[] = [];
    for (const source of sources) {
      const skip = (reason: SkipReason, detail?: string) =>
        skipped.push({ source, reason, ...(detail ? { detail } : {}) });
      if (options.only && !options.only.includes(source.slug)) {
        skip("NOT_REQUESTED");
        continue;
      }
      if (source.status !== "ACTIVE") {
        skip("SOURCE_NOT_ACTIVE", source.status);
        continue;
      }
      const connector = this.connectors.get(source.slug);
      if (!connector) {
        skip("NO_CONNECTOR");
        continue;
      }
      if (this.disabled.has(connector.id)) {
        skip("CONNECTOR_DISABLED");
        continue;
      }
      if (connector.isMock && !options.allowMocks) {
        skip("MOCK_NOT_ALLOWED");
        continue;
      }
      const readiness = connector.getReadiness();
      if (readiness.state === "PENDING_CREDENTIALS") {
        skip("NOT_CONFIGURED", `missing: ${readiness.missing.join(", ")}`);
        continue;
      }
      if (readiness.state === "PENDING_APPROVAL") {
        skip("PENDING_APPROVAL", readiness.reason);
        continue;
      }
      if (readiness.state === "NOT_SUPPORTED") {
        skip("NOT_SUPPORTED", readiness.reason);
        continue;
      }
      const caps = connector.getCapabilities();
      if (!caps.search) {
        skip("NO_SEARCH_CAPABILITY");
        continue;
      }
      if (
        request.category &&
        caps.categories !== "all" &&
        !caps.categories.includes(request.category)
      ) {
        skip("CATEGORY_NOT_SUPPORTED");
        continue;
      }
      eligible.push({ connector, source });
    }
    return { eligible, skipped };
  }
}
