/**
 * Affiliate disclosure, shown next to every set of marketplace links. Links
 * go through DealMind's click endpoint, which may add an affiliate tag;
 * rankings and recommendations never use commissions.
 */
import { Info } from "lucide-react";

export const AFFILIATE_DISCLOSURE =
  "DealMind AI may earn a commission when you buy through some marketplace links. This doesn't affect our rankings or recommendations, or the price you pay.";

export const DISCLOSURE_ID = "affiliate-disclosure";

/** Outbound marketplace link for an offer (the server validates the destination). */
export const buyHref = (
  offerId: string,
  from: "product" | "search" | "compare" | "watchlist" | "alert",
) => `/api/v1/affiliate/click/${offerId}?from=${from}`;

export function AffiliateDisclosure({ id = DISCLOSURE_ID }: { id?: string }) {
  return (
    <p id={id} className="flex items-start gap-2 text-xs text-muted-foreground">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-medium text-foreground">Affiliate disclosure: </span>
        {AFFILIATE_DISCLOSURE}
      </span>
    </p>
  );
}
