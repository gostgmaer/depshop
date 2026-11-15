"use client";

import { motion } from "framer-motion";
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
import { rupees } from "@/lib/format";
import type { SearchResultView } from "@/types/api";

/** One ranked deal: verified facts first, conditional benefits visibly separate. */
export function ResultCard({ result, index }: { result: SearchResultView; index: number }) {
  const { offer, product, pricing } = result;
  const delivered = pricing?.prices.deliveredPaise ?? offer.sellingPricePaise;
  const variantHref = `/products/${product.id}?variant=${offer.variantId}`;
  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 8) * 0.03 }}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-card) sm:flex-row"
      aria-labelledby={`result-${offer.id}`}
    >
      <div className="flex gap-4 sm:w-[45%]">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent tabular"
          aria-label={`Rank ${result.rank}`}
        >
          {result.rank}
        </span>
        <ProductImage src={product.imageUrl} alt={product.name} size={84} />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{product.brand}</p>
          <h3 id={`result-${offer.id}`} className="font-medium">
            <Link href={variantHref} className="hover:underline">
              {product.name}
            </Link>
          </h3>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={offer.title}>
            {offer.title}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="outline">{offer.source.name}</Badge>
            {offer.source.isSample ? <Badge tone="warning">Sample data</Badge> : null}
            <StockBadge status={offer.stockStatus} />
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="text-2xl font-semibold tracking-tight tabular">{rupees(delivered)}</p>
          {pricing?.directDiscount.status === "OK" && pricing.directDiscount.amountPaise ? (
            <p className="text-sm text-muted-foreground line-through tabular">
              {rupees(pricing.directDiscount.mrpPaise)}
            </p>
          ) : null}
          <span className="text-xs text-muted-foreground">
            delivered ·{" "}
            {pricing
              ? pricing.prices.shippingKnown
                ? pricing.prices.shippingPaise
                  ? `incl. ${rupees(pricing.prices.shippingPaise)} shipping`
                  : "free shipping"
                : "shipping not stated"
              : "price at search"}
          </span>
        </div>
        {pricing ? (
          <>
            <DiscountIndicator pricing={pricing} />
            <HistoryContext pricing={pricing} />
            <BenefitList benefits={pricing.benefits} limit={2} />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Current pricing unavailable; showing the price when you searched.
          </p>
        )}
        {result.explanation ? (
          <p className="flex gap-1.5 text-xs text-muted-foreground">
            <Sparkles aria-hidden className="mt-px size-3.5 shrink-0 text-accent" />
            <span>{result.explanation}</span>
          </p>
        ) : null}
        <ObservedAt iso={pricing?.observedAt ?? offer.observedAt} stale={offer.isStale} />
        <div className="mt-1 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/compare?product=${product.id}&variant=${offer.variantId}`}>
              <GitCompareArrows aria-hidden className="size-4" /> Compare prices
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
    </motion.article>
  );
}
