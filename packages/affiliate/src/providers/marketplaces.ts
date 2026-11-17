/**
 * Marketplace affiliate adapters, written to the partners' documented link
 * formats (verified 2026-11):
 *
 *  - Amazon Associates (India): the Associates store id is the `tag`
 *    parameter of an amazon.in product link; the Creators API adds the same
 *    partner tag to the links it returns. A per-click sub-id isn't part of the
 *    standard Associates link, so none is added. No India reporting API was
 *    verified: conversions are imported manually from Associates Central.
 *  - Flipkart Affiliate: the affiliate tracking id is the `affid` parameter;
 *    `affExtParam1` carries a sub-id that the Orders Report API returns, which
 *    is how a reported order is matched back to a click.
 *  - Croma, Reliance Digital, Tata CLiQ: no verified direct program; Croma and
 *    Tata CLiQ appear only through affiliate networks that need their own
 *    approval. They use the direct provider (no affiliate tag) until a
 *    verified integration exists.
 */
import type { AffiliateLink, AffiliateProvider, LinkContext, ProgramStatus } from "./interface.js";

export class AmazonAssociatesProvider implements AffiliateProvider {
  readonly id = "amazon-associates";
  readonly allowedHosts = ["www.amazon.in", "amazon.in"] as const;

  constructor(private readonly tag: string | null) {}

  link(destination: URL): AffiliateLink {
    if (!this.tag) return { url: destination.toString(), trackingId: null };
    const u = new URL(destination);
    u.searchParams.set("tag", this.tag);
    return { url: u.toString(), trackingId: this.tag };
  }

  status(): ProgramStatus {
    return {
      provider: this.id,
      marketplace: "Amazon India",
      linksActive: Boolean(this.tag),
      reporting: this.tag ? "manual" : "none",
      note: this.tag
        ? "Associates tag configured. No verified India reporting API: import reports from Associates Central."
        : "No Associates tag configured (AMAZON_ASSOCIATES_PARTNER_TAG); links go out without a tag.",
    };
  }
}

export class FlipkartAffiliateProvider implements AffiliateProvider {
  readonly id = "flipkart-affiliate";
  readonly allowedHosts = ["www.flipkart.com", "flipkart.com", "dl.flipkart.com"] as const;

  constructor(
    private readonly affiliateId: string | null,
    private readonly reportingConfigured: boolean,
  ) {}

  link(destination: URL, ctx: LinkContext): AffiliateLink {
    if (!this.affiliateId) return { url: destination.toString(), trackingId: null };
    const u = new URL(destination);
    u.searchParams.set("affid", this.affiliateId);
    u.searchParams.set("affExtParam1", ctx.clickRef);
    return { url: u.toString(), trackingId: this.affiliateId };
  }

  status(): ProgramStatus {
    return {
      provider: this.id,
      marketplace: "Flipkart",
      linksActive: Boolean(this.affiliateId),
      reporting: !this.affiliateId ? "none" : this.reportingConfigured ? "api" : "manual",
      note: !this.affiliateId
        ? "No Flipkart affiliate id configured (FLIPKART_AFFILIATE_ID); links go out without a tag."
        : this.reportingConfigured
          ? "Affiliate id and API token configured: orders can be imported from the Orders Report API."
          : "Affiliate id configured; set FLIPKART_AFFILIATE_TOKEN to import orders from the Report API.",
    };
  }
}

/** No affiliate relationship: the stored marketplace link, unchanged. */
export class DirectProvider implements AffiliateProvider {
  readonly id = "direct";
  constructor(
    readonly allowedHosts: readonly string[],
    private readonly marketplace: string,
    private readonly reason: string,
  ) {}

  link(destination: URL): AffiliateLink {
    return { url: destination.toString(), trackingId: null };
  }

  status(): ProgramStatus {
    return {
      provider: this.id,
      marketplace: this.marketplace,
      linksActive: false,
      reporting: "none",
      note: this.reason,
    };
  }
}

/** Development/test double: tags links with a fake id, never claims a real partnership. */
export class MockAffiliateProvider implements AffiliateProvider {
  readonly id = "mock-affiliate";
  constructor(readonly allowedHosts: readonly string[]) {}

  link(destination: URL, ctx: LinkContext): AffiliateLink {
    const u = new URL(destination);
    u.searchParams.set("mock_aff", "dealmind-test");
    u.searchParams.set("mock_sub", ctx.clickRef);
    return { url: u.toString(), trackingId: "dealmind-test" };
  }

  status(): ProgramStatus {
    return {
      provider: this.id,
      marketplace: "Mock (test only)",
      linksActive: true,
      reporting: "manual",
      note: "Test double for development; not a real affiliate program.",
    };
  }
}
