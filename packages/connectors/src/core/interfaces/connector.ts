import type {
  ConnectorCapabilities,
  ConnectorHealth,
  ConnectorReadiness,
  ConnectorSearchResultInput,
  NormalizedProductInput,
  ValidSearchRequest,
} from "../types/schemas.js";

export interface ConnectorCallContext {
  /** Aborted on timeout or shutdown: connectors must pass it to fetch(). */
  signal: AbortSignal;
}

/**
 * The contract every marketplace integration implements. Connectors are
 * plain classes: no LangGraph, no database, no Redis. Cross-cutting concerns
 * (timeouts, retries, rate limits, circuit breaking, caching, validation,
 * metrics) are applied by the executor, so each connector stays small.
 *
 * `id` equals the ShoppingSource.slug the connector serves.
 */
export interface ShoppingConnector {
  readonly id: string;
  readonly name: string;
  /** True for mock connectors: their data is never real marketplace data. */
  readonly isMock: boolean;

  getCapabilities(): ConnectorCapabilities;
  /** Configuration state without any network call (credentials present, approval…). */
  getReadiness(): ConnectorReadiness;

  /** Raw result; the executor validates items with normalizedProductSchema. */
  search(
    request: ValidSearchRequest,
    ctx: ConnectorCallContext,
  ): Promise<ConnectorSearchResultInput>;
  getProduct?(
    externalId: string,
    ctx: ConnectorCallContext,
  ): Promise<NormalizedProductInput | null>;
  getHealth(ctx: ConnectorCallContext): Promise<ConnectorHealth>;
}
