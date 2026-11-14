/**
 * Amazon India — Amazon Creators API (successor of PA-API 5.0; PA-API is NOT
 * used as a new integration target).
 *
 * Verified from Amazon's Associates documentation (2026-11):
 *  - OAuth 2.0 client credentials (Credential ID + Secret), scope
 *    `creatorsapi::default`, bearer tokens valid 3600 s;
 *  - base https://creatorsapi.amazon/catalog/v1/ (e.g. POST searchItems);
 *  - `x-marketplace` header and `partnerTag` in the body.
 * NOT verifiable from public pages: the regional token endpoint, the India
 * marketplace value and the OffersV2 price/availability schema. Eligibility
 * needs an approved Amazon.in Associates account (sales thresholds are
 * reported by third parties, unconfirmed for India).
 *
 * Therefore no network client exists yet: inventing the missing pieces would
 * violate "never invent endpoints". The connector reports exactly what is
 * pending and refuses to search.
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

export interface AmazonCreatorsConfig {
  credentialId?: string | undefined;
  credentialSecret?: string | undefined;
  partnerTag?: string | undefined;
}

export const AMAZON_PENDING_REASON =
  "Creators API client not implemented: needs approved Amazon.in Associates account, then verification of the region token endpoint, India marketplace value and OffersV2 schema from the authenticated docs.";

export class AmazonCreatorsConnector implements ShoppingConnector {
  readonly id = "amazon_in";
  readonly name = "Amazon India";
  readonly isMock = false;

  constructor(private readonly config: AmazonCreatorsConfig) {}

  getCapabilities(): ConnectorCapabilities {
    // Declared as nothing until a verified client exists.
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
    const missing = [
      ...(this.config.credentialId ? [] : ["AMAZON_CREATORS_CREDENTIAL_ID"]),
      ...(this.config.credentialSecret ? [] : ["AMAZON_CREATORS_CREDENTIAL_SECRET"]),
      ...(this.config.partnerTag ? [] : ["AMAZON_ASSOCIATES_PARTNER_TAG"]),
    ];
    if (missing.length) return { state: "PENDING_CREDENTIALS", missing };
    return { state: "PENDING_APPROVAL", reason: AMAZON_PENDING_REASON };
  }

  async search(
    _request: ValidSearchRequest,
    _ctx: ConnectorCallContext,
  ): Promise<ConnectorSearchResultInput> {
    throw new ConnectorError("NOT_SUPPORTED", AMAZON_PENDING_REASON, { retryable: false });
  }

  async getHealth(): Promise<ConnectorHealth> {
    return { status: "UNKNOWN", checkedAt: new Date(), message: AMAZON_PENDING_REASON };
  }
}
