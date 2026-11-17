/**
 * Affiliate provider abstraction. A provider turns a stored, validated
 * marketplace URL into an authorized affiliate link (adding only its own
 * tracking parameters), declares which destination hosts it accepts, and
 * reports what it can and can't do. Nothing here invents a partnership,
 * a commission rate or an endpoint: an unconfigured provider is "direct"
 * (no affiliate tag), and reporting is "none" unless a verified API exists.
 */

export type ReportingMode =
  /** Conversions can be imported from a documented partner API. */
  | "api"
  /** The partner offers reports, but no verified API here: import manually from its dashboard. */
  | "manual"
  /** No reporting (no affiliate relationship). */
  | "none";

export interface ProgramStatus {
  provider: string;
  /** Marketplace the program belongs to. */
  marketplace: string;
  /** Affiliate links are being generated (tracking id configured and source enabled). */
  linksActive: boolean;
  reporting: ReportingMode;
  /** Plain-language status for admins. */
  note: string;
}

export interface LinkContext {
  /** Opaque per-click reference, passed as a sub-id where the partner supports one. */
  clickRef: string;
}

export interface AffiliateLink {
  url: string;
  /** Non-secret tracking id that was attached (null = no affiliate tag). */
  trackingId: string | null;
}

export interface AffiliateProvider {
  /** Stored on clicks and conversions ("amazon-associates", "flipkart-affiliate", "direct"). */
  readonly id: string;
  /** Hosts this provider may send users to (exact host match). */
  readonly allowedHosts: readonly string[];
  /** Builds the outbound link for an already-validated destination. */
  link(destination: URL, ctx: LinkContext): AffiliateLink;
  status(): ProgramStatus;
}
