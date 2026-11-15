"use client";

import { GitCompareArrows, Sparkles } from "lucide-react";
import Link from "next/link";
import { PriceAlertDialog } from "@/components/alerts/price-alert-form";
import {
  BenefitList,
  DiscountIndicator,
  HistoryContext,
  ObservedAt,
  StockBadge,
} from "@/components/offers/pricing-parts";
import { ProductImage } from "@/components/products/product-card";
import { WatchlistButton } from "@/components/products/watchlist-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { rupees, variantSummary } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SearchResultView } from "@/types/api";
import { CompareToggle } from "./compare-selection";

export type ResultLayout = "list" | "grid";

/** Shipping as the engine states it; never "free" unless the source said 0. */
function shippingText(r: SearchResultView): string {
  const p = r.pricing;
  if (!p) return "price when you searched";
  if (!p.prices.shippingKnown) return "shipping not stated";
  return p.prices.shippingPaise
    ? `incl. ${rupees(p.prices.shippingPaise)} shipping`
    : "free shipping";
}

function MrpLine({ result }: { result: SearchResultView }) {
  const d = result.pricing?.directDiscount;
  if (!d || d.mrpPaise === null) return null;
  if (d.status === "OK" && d.amountPaise)
    return (
      <p className="text-sm text-muted-foreground tabular">
        <span className="sr-only">MRP </span>
        <s>{rupees(d.mrpPaise)}</s>
        <span className="ml-1.5 text-primary">save {rupees(d.amountPaise)}</span>
      </p>
    );
  if (d.status === "OK") return null;
  return (
    <p className="text-xs text-muted-foreground tabular">
      Listed MRP {rupees(d.mrpPaise)} · not verified
    </p>
  );
}

/** One ranked deal: verified facts first, conditional benefits visibly separate. */
export function ResultCard({
  result,
  layout = "list",
}: {
  result: SearchResultView;
  layout?: ResultLayout;
}) {
  const { offer, product, pricing } = result;
  const delivered = pricing?.prices.deliveredPaise ?? result.pricePaiseAtSearch;
  const variant = variantSummary(result.variantAttributes);
  const variantHref = `/products/${product.id}?variant=${offer.variantId}`;
  const grid = layout === "grid";
  return (
    <article
      className={cn(
        "flex h-full flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-card)",
        !grid && "sm:flex-row",
      )}
      aria-labelledby={`result-${offer.id}`}
    >
      <div className={cn("flex gap-4", !grid && "sm:w-[45%]")}>
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent tabular"
          aria-label={`Rank ${result.rank}`}
        >
          {result.rank}
        </span>
        <ProductImage src={product.imageUrl} alt={product.name} size={grid ? 64 : 84} />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {product.brand}
            {product.modelNumber ? ` · Model ${product.modelNumber}` : ""}
          </p>
          <h3 id={`result-${offer.id}`} className="font-medium">
            <Link href={variantHref} className="hover:underline">
              {product.name}
            </Link>
          </h3>
          {variant.length ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{variant.join(" · ")}</p>
          ) : null}
          {grid ? null : (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={offer.title}>
              {offer.title}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="outline">{offer.source.name}</Badge>
            {offer.source.isSample ? <Badge tone="warning">Sample data</Badge> : null}
            <StockBadge status={offer.stockStatus} />
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2">
        <div>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-2xl font-semibold tracking-tight tabular">
              {rupees(delivered)}
            </span>
            <span className="text-xs text-muted-foreground">
              delivered · {shippingText(result)}
            </span>
          </p>
          {pricing && pricing.prices.basePaise !== delivered ? (
            <p className="text-xs text-muted-foreground tabular">
              Selling price {rupees(pricing.prices.basePaise)}
            </p>
          ) : null}
          <MrpLine result={result} />
        </div>
        {pricing ? (
          <>
            <DiscountIndicator pricing={pricing} compact={grid} />
            <HistoryContext pricing={pricing} />
            <BenefitList benefits={pricing.benefits} limit={grid ? 1 : 2} />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Current pricing unavailable; showing the price when you searched.
          </p>
        )}
        {result.explanation && !grid ? (
          <p className="flex gap-1.5 text-xs text-muted-foreground">
            <Sparkles aria-hidden className="mt-px size-3.5 shrink-0 text-accent" />
            <span>{result.explanation}</span>
          </p>
        ) : null}
        <ObservedAt iso={pricing?.observedAt ?? offer.observedAt} stale={offer.isStale} />
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <CompareToggle
            pick={{
              productId: product.id,
              variantId: offer.variantId,
              name: product.name,
              variantLabel: variant.join(" · "),
            }}
          />
          <Button variant="outline" size="sm" asChild>
            <Link href={`/compare?product=${product.id}&variant=${offer.variantId}`}>
              <GitCompareArrows aria-hidden className="size-4" />
              <span>
                Marketplaces <span className="sr-only">for {product.name}</span>
              </span>
            </Link>
          </Button>
          <WatchlistButton variantId={offer.variantId} />
          <PriceAlertDialog
            variantId={offer.variantId}
            currentPricePaise={delivered}
            sources={[{ id: offer.source.id, name: offer.source.name }]}
          />
        </div>
      </div>
    </article>
  );
}
