import type {
  ConnectorCapabilities,
  ConnectorHealth,
  ConnectorReadiness,
  ConnectorSearchResultInput,
  NormalizedProductInput,
  ValidSearchRequest,
} from "../types/schemas.js";

/** One page of a store's discounted products (deals feed). */
export interface DealFeedRequest {
  /** Only items at least this far below MRP (basis points: 2000 = 20%). */
  minDiscountBp: number;
  /** Opaque continuation from the previous page; absent for the first page. */
  cursor?: string;
}

export interface DealFeedPage {
  sourceId: string;
  /** Raw items; the runner validates them with normalizedProductSchema. */
  items: unknown[];
  /** Continuation for the next page; absent on the last page. */
  nextCursor?: string;
  fetchedAt: Date;
}

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
  /** Bulk list of discounted products (capability `dealFeed`). */
  fetchDeals?(request: DealFeedRequest, ctx: ConnectorCallContext): Promise<DealFeedPage>;
  getHealth(ctx: ConnectorCallContext): Promise<ConnectorHealth>;
}
