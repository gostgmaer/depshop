"use client";

import { ExternalLink, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { rupees } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OfferPricingView, ProductPricingView } from "@/types/api";
import {
  BenefitList,
  DiscountIndicator,
  HistoryContext,
  ObservedAt,
  StockBadge,
} from "./pricing-parts";

/**
 * Marketplace price comparison. Desktop: a table; mobile: stacked cards.
 * Rows are ordered by delivered price (the API already sorts them).
 */
export function OfferComparisonTable({ data }: { data: ProductPricingView }) {
  const cheapest = data.comparison.cheapestDelivered;
  if (!data.offers.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {!data.comparison.sameVariant ? (
        <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          These offers cover different variants — pick a variant to compare like for like.
        </p>
      ) : null}
      <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Prices of this product across marketplaces</caption>
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Marketplace
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Delivered price
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Discount (verified)
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Conditional offers
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Availability
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                <span className="sr-only">Link</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.offers.map((row) => (
              <OfferRow key={row.offer.id} row={row} best={row.offer.id === cheapest} />
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-3 md:hidden">
        {data.offers.map((row) => (
          <li key={row.offer.id}>
            <OfferCard row={row} best={row.offer.id === cheapest} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Marketplace({ row, best }: { row: OfferPricingView; best: boolean }) {
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
      </span>
      {row.offer.sellerName ? (
        <span className="text-xs text-muted-foreground">Sold by {row.offer.sellerName}</span>
      ) : null}
      <ObservedAt iso={row.pricing.observedAt} stale={row.offer.isStale} />
    </div>
  );
}

function OfferRow({ row, best }: { row: OfferPricingView; best: boolean }) {
  const p = row.pricing;
  return (
    <tr className={cn("border-t border-border align-top", best && "bg-primary-soft/40")}>
      <td className="px-4 py-3">
        <Marketplace row={row} best={best} />
      </td>
      <td className="px-4 py-3">
        <p className="text-base font-semibold tabular">{rupees(p.prices.deliveredPaise)}</p>
        <p className="text-xs text-muted-foreground">
          {rupees(p.prices.basePaise)} +{" "}
          {p.prices.shippingKnown
            ? p.prices.shippingPaise
              ? rupees(p.prices.shippingPaise)
              : "free"
            : "shipping not stated"}
        </p>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1.5">
          <DiscountIndicator pricing={p} />
          <HistoryContext pricing={p} />
        </div>
      </td>
      <td className="max-w-72 px-4 py-3">
        {p.benefits.length ? (
          <BenefitList benefits={p.benefits} limit={2} />
        ) : (
          <span className="text-xs text-muted-foreground">None stated</span>
        )}
      </td>
      <td className="px-4 py-3">
        <StockBadge status={p.stockStatus} />
      </td>
      <td className="px-4 py-3">
        <MarketplaceLink row={row} />
      </td>
    </tr>
  );
}

export function OfferCard({ row, best }: { row: OfferPricingView; best: boolean }) {
  const p = row.pricing;
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-surface p-4",
        best && "border-primary/40",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Marketplace row={row} best={best} />
        <p className="text-lg font-semibold tabular">{rupees(p.prices.deliveredPaise)}</p>
      </div>
      <DiscountIndicator pricing={p} />
      <HistoryContext pricing={p} />
      <BenefitList benefits={p.benefits} limit={2} />
      <div className="flex items-center justify-between">
        <StockBadge status={p.stockStatus} />
        <MarketplaceLink row={row} />
      </div>
    </article>
  );
}

function MarketplaceLink({ row }: { row: OfferPricingView }) {
  if (row.offer.source.isSample)
    return <span className="text-xs text-muted-foreground">Sample store — no real listing</span>;
  return (
    <a
      href={row.offer.productUrl}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
    >
      View <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only">on {row.offer.source.name} (opens in a new tab)</span>
    </a>
  );
}
