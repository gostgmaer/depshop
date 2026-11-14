/**
 * Web discovery: finds products through an AUTHORIZED search provider or
 * licensed feed (provider-specific code lives behind `DiscoveryProvider`).
 *
 * Discovery data is never treated as a verified offer: prices from snippets
 * are `INDICATIVE` (the schema forbids that price type for any other
 * provenance), and `toSourceListing` refuses to store them as offers. They
 * can point users to a marketplace page; the price must be confirmed there.
 *
 * No provider is configured in this repository, so the connector reports
 * PENDING_CREDENTIALS until one is supplied.
 */
import type { ConnectorCallContext, ShoppingConnector } from "../core/interfaces/connector.js";
import { ConnectorError } from "../core/types/errors.js";
import type {
  ConnectorCapabilities,
  ConnectorHealth,
  ConnectorReadiness,
  ConnectorSearchResultInput,
  NormalizedProductInput,
  ValidSearchRequest,
} from "../core/types/schemas.js";

export interface DiscoveryHit {
  title: string;
  url: string;
  brand?: string;
  /** Price text as shown by the provider, if any (e.g. "₹1,299"). */
  priceText?: string;
  pricePaise?: number;
  externalId?: string;
}

export interface DiscoveryProvider {
  /** e.g. "licensed-feed-x"; appears in provenance. */
  readonly id: string;
  search(request: ValidSearchRequest, ctx: ConnectorCallContext): Promise<DiscoveryHit[]>;
}

export class WebDiscoveryConnector implements ShoppingConnector {
  readonly id = "web_discovery";
  readonly name = "Web discovery";
  readonly isMock = false;

  constructor(private readonly provider?: DiscoveryProvider) {}

  getCapabilities(): ConnectorCapabilities {
    return {
      search: true,
      productLookup: false,
      categories: "all",
      price: false, // indicative only
      mrp: false,
      stock: false,
      shipping: false,
      promotions: false,
      maxResultsPerRequest: 20,
    };
  }

  getReadiness(): ConnectorReadiness {
    return this.provider
      ? { state: "READY" }
      : { state: "PENDING_CREDENTIALS", missing: ["WEB_DISCOVERY_PROVIDER"] };
  }

  async search(
    request: ValidSearchRequest,
    ctx: ConnectorCallContext,
  ): Promise<ConnectorSearchResultInput> {
    if (!this.provider) {
      throw new ConnectorError("NOT_CONFIGURED", "No authorized discovery provider configured", {
        retryable: false,
      });
    }
    const now = new Date();
    const hits = await this.provider.search(request, ctx);
    const items = hits.map((h, i): NormalizedProductInput | DiscoveryHit =>
      h.pricePaise === undefined || !h.brand
        ? h // no price/brand: not a product result; the executor rejects and counts it
        : {
            sourceId: this.id,
            externalId: h.externalId ?? `${this.provider!.id}:${i}:${h.url}`.slice(0, 200),
            title: h.title,
            brand: h.brand,
            productUrl: h.url,
            sellingPricePaise: h.pricePaise,
            priceType: "INDICATIVE",
            currency: "INR",
            stockStatus: "UNKNOWN",
            observedAt: now,
            provenance: { method: "DISCOVERY", provider: this.provider!.id, retrievedAt: now },
          },
    );
    return { sourceId: this.id, items, fetchedAt: now };
  }

  async getHealth(): Promise<ConnectorHealth> {
    return {
      status: this.provider ? "UNKNOWN" : "DOWN",
      checkedAt: new Date(),
      message: this.provider ? `Provider ${this.provider.id}` : "No discovery provider configured",
    };
  }
}
