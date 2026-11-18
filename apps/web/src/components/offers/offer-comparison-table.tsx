"use client";

import { ExternalLink, History, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { relativeTime, rupees } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OfferPricingView, ProductPricingView } from "@/types/api";
import { AffiliateDisclosure, DISCLOSURE_ID, buyHref } from "./affiliate-disclosure";
import { BenefitList, DiscountIndicator, ObservedAt, StockBadge } from "./pricing-parts";

/**
 * Marketplace comparison for one variant: a table on desktop, cards on mobile.
 * Rows are ordered by delivered price (the API sorts them). The "lowest" mark
 * goes only to the lowest eligible (fresh, available) delivered price; offers
 * not observed recently are listed as "last seen", never as current.
 */
export function OfferComparisonTable({
  data,
  surface = "product",
}: {
  data: ProductPricingView;
  /** Where the click came from (recorded with the click; no personal data). */
  surface?: "product" | "compare";
}) {
  const cheapest = data.comparison.cheapestDelivered;
  if (!data.offers.length) return null;
  const real = data.offers.some((o) => !o.offer.source.isSample);
  const stale = data.offers.filter((o) => o.offer.isStale).length;
  return (
    <div className="flex flex-col gap-3">
      {!data.comparison.sameVariant ? (
        <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          These offers cover different variants — pick a variant to compare like for like.
        </p>
      ) : null}
      {stale ? (
        <p className="text-xs text-muted-foreground">
          {stale} offer{stale === 1 ? " hasn't" : "s haven't"} been observed in the last 24 hours:
          shown as last seen, not as current prices, and never chosen as lowest.
        </p>
      ) : null}
      <div className="relative hidden overflow-x-auto rounded-xl border border-border lg:block">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Prices of this variant across marketplaces, cheapest delivered first
          </caption>
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              {[
                "Marketplace",
                "Selling price",
                "MRP",
                "Direct discount",
                "Shipping",
                "Delivered price",
                "Availability",
                "Conditional offers",
              ].map((h) => (
                <th key={h} scope="col" className="px-3 py-2.5 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
              <th scope="col" className="px-3 py-2.5 font-medium">
                <span className="sr-only">Product link</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.offers.map((row) => (
              <OfferRow
                key={row.offer.id}
                row={row}
                best={row.offer.id === cheapest}
                surface={surface}
              />
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-3 lg:hidden">
        {data.offers.map((row) => (
          <li key={row.offer.id}>
            <OfferCard row={row} best={row.offer.id === cheapest} surface={surface} />
          </li>
        ))}
      </ul>
      {real ? <AffiliateDisclosure /> : null}
    </div>
  );
}

function shipping(row: OfferPricingView): string {
  const p = row.pricing.prices;
  if (!p.shippingKnown) return "Not stated";
  return p.shippingPaise ? rupees(p.shippingPaise) : "Free";
}

function mrp(row: OfferPricingView): { text: string; note: string | null } {
  const d = row.pricing.directDiscount;
  if (d.mrpPaise === null) return { text: "Not stated", note: null };
  return {
    text: rupees(d.mrpPaise),
    note: d.status === "OK" ? null : "not verified",
  };
}

function Marketplace({ row, best }: { row: OfferPricingView; best: boolean }) {
  const stale = row.offer.isStale;
  return (
    <div className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5 font-medium">
        {row.offer.source.name}
        {row.offer.source.isSample ? <Badge tone="warning">Sample data</Badge> : null}
        {best ? (
          <Badge tone="success">
            <Trophy aria-hidden className="size-3" /> Lowest delivered
          </Badge>
        ) : null}
        {stale ? (
          <Badge tone="neutral">
            <History aria-hidden className="size-3" /> Not current
          </Badge>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">
        {row.offer.sellerName ? `Sold by ${row.offer.sellerName}` : "Seller not stated"}
      </span>
      <ObservedAt iso={row.pricing.observedAt} stale={stale} />
    </div>
  );
}

type Surface = "product" | "compare";

function OfferRow({
  row,
  best,
  surface,
}: {
  row: OfferPricingView;
  best: boolean;
  surface: Surface;
}) {
  const p = row.pricing;
  const m = mrp(row);
  const stale = row.offer.isStale;
  return (
    <tr
      className={cn(
        "border-t border-border align-top",
        best && "bg-primary-soft/40",
        stale && "text-muted-foreground",
      )}
    >
      <td className="px-3 py-3">
        <Marketplace row={row} best={best} />
      </td>
      <td className="px-3 py-3 tabular">{rupees(p.prices.basePaise)}</td>
      <td className="px-3 py-3 tabular">
        {m.text}
        {m.note ? <span className="block text-xs text-muted-foreground">{m.note}</span> : null}
      </td>
      <td className="px-3 py-3">
        <DiscountIndicator pricing={p} compact />
      </td>
      <td className="px-3 py-3 tabular">{shipping(row)}</td>
      <td className="px-3 py-3">
        <p className="text-base font-semibold tabular">{rupees(p.prices.deliveredPaise)}</p>
        {stale ? (
          <p className="text-xs">last seen {relativeTime(p.observedAt)}</p>
        ) : p.prices.mandatoryFeesPaise ? (
          <p className="text-xs text-muted-foreground">
            incl. {rupees(p.prices.mandatoryFeesPaise)} fees
          </p>
        ) : null}
      </td>
      <td className="px-3 py-3">
        <StockBadge status={p.stockStatus} />
      </td>
      <td className="min-w-60 px-3 py-3">
        {p.benefits.length ? (
          <BenefitList benefits={p.benefits} limit={2} />
        ) : (
          <span className="text-xs text-muted-foreground">None stated</span>
        )}
      </td>
      <td className="px-3 py-3">
        <MarketplaceLink row={row} surface={surface} />
      </td>
    </tr>
  );
}

export function OfferCard({
  row,
  best,
  surface,
}: {
  row: OfferPricingView;
  best: boolean;
  surface: Surface;
}) {
  const p = row.pricing;
  const m = mrp(row);
  const stale = row.offer.isStale;
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-surface p-4",
        best && "border-primary/40",
        stale && "bg-muted/40",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Marketplace row={row} best={best} />
        <div className="text-right">
          <p className="text-lg font-semibold tabular">{rupees(p.prices.deliveredPaise)}</p>
          <p className="text-xs text-muted-foreground">
            {stale ? `last seen ${relativeTime(p.observedAt)}` : "delivered"}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Selling</dt>
          <dd className="tabular">{rupees(p.prices.basePaise)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">MRP</dt>
          <dd className="tabular">
            {m.text}
            {m.note ? ` (${m.note})` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Shipping</dt>
          <dd className="tabular">{shipping(row)}</dd>
        </div>
      </dl>
      <DiscountIndicator pricing={p} compact />
      <BenefitList benefits={p.benefits} limit={2} />
      <div className="flex items-center justify-between">
        <StockBadge status={p.stockStatus} />
        <MarketplaceLink row={row} surface={surface} />
      </div>
    </article>
  );
}

function MarketplaceLink({
  row,
  surface,
}: {
  row: OfferPricingView;
  surface: "product" | "compare";
}) {
  if (row.offer.source.isSample)
    return <span className="text-xs text-muted-foreground">Sample store — no real listing</span>;
  return (
    <a
      href={buyHref(row.offer.id, surface)}
      target="_blank"
      rel="noopener nofollow sponsored"
      aria-describedby={DISCLOSURE_ID}
      className="inline-flex min-h-11 items-center gap-1 text-sm font-medium whitespace-nowrap text-accent hover:underline"
    >
      Buy on {row.offer.source.name} <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only">(opens the marketplace in a new tab)</span>
    </a>
  );
}
