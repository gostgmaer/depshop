/**
 * The production registry: every target marketplace has a connector entry so
 * its status can be reported, even when it can't search yet.
 * Credentials come only from the environment (never the database).
 */
import { AmazonCreatorsConnector } from "./amazon/amazon-connector.js";
import { ConnectorRegistry } from "./core/registry/registry.js";
import { cromaConnector } from "./croma/partner-pending-connector.js";
import { FlipkartConnector } from "./flipkart/flipkart-connector.js";
import { MockConnector } from "./mock/mock-connector.js";
import { relianceDigitalConnector } from "./reliance/index.js";
import { tataCliqConnector } from "./tatacliq/index.js";
import {
  type DiscoveryProvider,
  WebDiscoveryConnector,
} from "./web-discovery/web-discovery-connector.js";

export interface RegistryEnv {
  NODE_ENV?: string | undefined;
  FLIPKART_AFFILIATE_ID?: string | undefined;
  FLIPKART_AFFILIATE_TOKEN?: string | undefined;
  AMAZON_CREATORS_CREDENTIAL_ID?: string | undefined;
  AMAZON_CREATORS_CREDENTIAL_SECRET?: string | undefined;
  AMAZON_ASSOCIATES_PARTNER_TAG?: string | undefined;
}

export const MOCK_SOURCES = [
  {
    slug: "mock_alpha",
    name: "Mock Store Alpha (mock data — not a real store)",
    priceFactorBp: 10_000,
  },
  {
    slug: "mock_beta",
    name: "Mock Store Beta (mock data — not a real store)",
    priceFactorBp: 9_700,
  },
] as const;

export function createDefaultRegistry(
  env: RegistryEnv,
  options: {
    includeMocks?: boolean;
    fetch?: typeof fetch;
    discoveryProvider?: DiscoveryProvider;
  } = {},
): ConnectorRegistry {
  const registry = new ConnectorRegistry()
    .register(
      new AmazonCreatorsConnector({
        credentialId: env.AMAZON_CREATORS_CREDENTIAL_ID,
        credentialSecret: env.AMAZON_CREATORS_CREDENTIAL_SECRET,
        partnerTag: env.AMAZON_ASSOCIATES_PARTNER_TAG,
      }),
    )
    .register(
      new FlipkartConnector({
        affiliateId: env.FLIPKART_AFFILIATE_ID,
        token: env.FLIPKART_AFFILIATE_TOKEN,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    )
    .register(cromaConnector())
    .register(relianceDigitalConnector())
    .register(tataCliqConnector())
    .register(new WebDiscoveryConnector(options.discoveryProvider));
  const mocks = options.includeMocks ?? env.NODE_ENV !== "production";
  if (mocks) {
    if (env.NODE_ENV === "production")
      throw new Error("Mock connectors are not allowed in production");
    for (const m of MOCK_SOURCES)
      registry.register(
        new MockConnector({ id: m.slug, name: m.name, priceFactorBp: m.priceFactorBp }),
      );
  }
  return registry;
}
