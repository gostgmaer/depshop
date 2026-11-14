/**
 * Marketplaces without a public, authorized product API or feed (researched
 * 2026-11): Croma, Reliance Digital and Tata CLiQ. Affiliate networks list
 * them for tracking links only. Access needs a partner/feed agreement, so
 * these connectors make no network calls and never return data. Scraping
 * their sites is not an option (terms, anti-bot protections).
 *
 * When an agreement exists, replace the instance in the registry with a real
 * implementation of ShoppingConnector for the provided API/feed.
 */
import type { ConnectorCallContext, ShoppingConnector } from "../core/interfaces/connector.js";
import { ConnectorError } from "../core/types/errors.js";
import type {
  ConnectorCapabilities,
  ConnectorHealth,
  ConnectorReadiness,
  ConnectorSearchResultInput,
  ValidSearchRequest,
} from "../core/types/schemas.js";

export class PartnerPendingConnector implements ShoppingConnector {
  readonly isMock = false;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly reason: string,
  ) {}

  getCapabilities(): ConnectorCapabilities {
    return {
      search: false,
      productLookup: false,
      categories: "all",
      price: false,
      mrp: false,
      stock: false,
      shipping: false,
      promotions: false,
      maxResultsPerRequest: 1,
    };
  }

  getReadiness(): ConnectorReadiness {
    return { state: "PENDING_APPROVAL", reason: this.reason };
  }

  async search(
    _request: ValidSearchRequest,
    _ctx: ConnectorCallContext,
  ): Promise<ConnectorSearchResultInput> {
    throw new ConnectorError("NOT_SUPPORTED", this.reason, { retryable: false });
  }

  async getHealth(): Promise<ConnectorHealth> {
    return { status: "UNKNOWN", checkedAt: new Date(), message: this.reason };
  }
}

export const cromaConnector = () =>
  new PartnerPendingConnector(
    "croma",
    "Croma",
    "No public product API or feed found; requires a partner/feed agreement with Croma (Tata Digital).",
  );
