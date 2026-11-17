/**
 * Chooses the affiliate provider for a shopping source. A source gets an
 * affiliate link only when an admin enabled affiliate links for it
 * (`affiliateEnabled`) AND the program's tracking id is configured;
 * otherwise the user goes to the plain stored link ("direct").
 */
import type { AffiliateProvider, ProgramStatus } from "./interface.js";
import {
  AmazonAssociatesProvider,
  DirectProvider,
  FlipkartAffiliateProvider,
} from "./marketplaces.js";

export interface AffiliateConfig {
  amazonPartnerTag?: string | null;
  flipkartAffiliateId?: string | null;
  flipkartAffiliateToken?: string | null;
}

export interface SourceLike {
  slug: string;
  name: string;
  domain: string;
  affiliateEnabled: boolean;
}

const NO_PROGRAM: Record<string, string> = {
  croma:
    "No verified direct affiliate program; offered only via affiliate networks needing separate approval.",
  tata_cliq:
    "No verified direct affiliate program; offered only via affiliate networks needing separate approval.",
  reliance_digital: "No verified affiliate program found.",
};

/** Hosts of a domain: the bare domain and its www host. */
const hostsOf = (domain: string) => {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return [d, `www.${d}`];
};

export class AffiliateRegistry {
  private readonly overrides = new Map<string, AffiliateProvider>();

  constructor(private readonly config: AffiliateConfig) {}

  /** Flipkart Report API credentials, when both are configured (never sent to clients). */
  flipkartReporting(): { affiliateId: string; token: string } | null {
    const { flipkartAffiliateId: id, flipkartAffiliateToken: token } = this.config;
    return id && token ? { affiliateId: id, token } : null;
  }

  /** Tests and development: use a specific provider for a source slug. */
  override(slug: string, provider: AffiliateProvider): void {
    this.overrides.set(slug, provider);
  }

  /** The program for a source (independent of whether the admin enabled it). */
  program(source: SourceLike): AffiliateProvider {
    const o = this.overrides.get(source.slug);
    if (o) return o;
    if (source.slug === "amazon_in")
      return new AmazonAssociatesProvider(this.config.amazonPartnerTag ?? null);
    if (source.slug === "flipkart")
      return new FlipkartAffiliateProvider(
        this.config.flipkartAffiliateId ?? null,
        Boolean(this.config.flipkartAffiliateId && this.config.flipkartAffiliateToken),
      );
    return new DirectProvider(
      hostsOf(source.domain),
      source.name,
      NO_PROGRAM[source.slug] ?? "No affiliate integration.",
    );
  }

  /** The provider actually used for outbound links (direct unless enabled by an admin). */
  forLinks(source: SourceLike): AffiliateProvider {
    const p = this.program(source);
    if (source.affiliateEnabled && p.status().linksActive) return p;
    // Same allowlist, no affiliate tag.
    return new DirectProvider(
      p.allowedHosts.length ? p.allowedHosts : hostsOf(source.domain),
      source.name,
      source.affiliateEnabled ? p.status().note : "Affiliate links are disabled for this source.",
    );
  }

  status(source: SourceLike): ProgramStatus & { enabled: boolean } {
    return { ...this.program(source).status(), enabled: source.affiliateEnabled };
  }
}
