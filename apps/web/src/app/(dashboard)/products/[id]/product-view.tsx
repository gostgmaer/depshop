"use client";

import { BadgeCheck, GitCompareArrows, HelpCircle, LineChart, TrendingDown } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PriceAlertDialog } from "@/components/alerts/price-alert-form";
import { PriceHistoryChart } from "@/components/charts/price-history-chart";
import { OfferComparisonTable } from "@/components/offers/offer-comparison-table";
import {
  BenefitList,
  DiscountIndicator,
  HistoryContext,
  ObservedAt,
  PriceBreakdown,
} from "@/components/offers/pricing-parts";
import { ProductCard, ProductImage } from "@/components/products/product-card";
import { WatchlistButton } from "@/components/products/watchlist-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, NativeSelect } from "@/components/ui/misc";
import { LoadingRows, Skeleton } from "@/components/ui/skeleton";
import { usePriceHistory, useProduct, useProductPricing, useProducts } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import { formatDate, percent, rupees, variantSummary } from "@/lib/format";

export function ProductView({ id }: { id: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const product = useProduct(id);
  const variants = product.data?.variants ?? [];
  const variantId = params.get("variant") ?? variants[0]?.id;
  const days = Number(params.get("days") ?? "90") || 90;
  const pricing = useProductPricing(id, variantId);
  const history = usePriceHistory(id, variantId, days);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    p.set(k, v);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  if (product.isPending)
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading product…</span>
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  if (product.isError)
    return product.error instanceof ApiError && product.error.status === 404 ? (
      <EmptyState
        icon={HelpCircle}
        title="Product not found"
        description="It may no longer be in the catalog."
      />
    ) : (
      <ErrorState message="Couldn't load this product." onRetry={() => void product.refetch()} />
    );

  const p = product.data;
  const best = pricing.data?.offers.find(
    (o) => o.offer.id === pricing.data?.comparison.cheapestDelivered,
  );
  const sourceNames = Object.fromEntries(
    (pricing.data?.offers ?? []).map((o) => [o.offer.source.slug, o.offer.source.name]),
  );
  const sources = [
    ...new Map(
      (pricing.data?.offers ?? []).map((o) => [
        o.offer.source.id,
        { id: o.offer.source.id, name: o.offer.source.name },
      ]),
    ).values(),
  ];
  const variant = variants.find((v) => v.id === variantId);

  return (
    <>
      <section className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 shadow-(--shadow-card) md:flex-row">
        <ProductImage src={p.imageUrl} alt={p.name} size={160} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <p className="text-sm text-muted-foreground">
              {p.brand}
              {p.category ? (
                <>
                  {" · "}
                  <Link href={`/categories/${p.category.slug}`} className="hover:underline">
                    {p.category.name}
                  </Link>
                </>
              ) : null}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {p.sampleData ? <Badge tone="warning">Sample data — not real offers</Badge> : null}
              {p.modelNumber ? <Badge tone="outline">Model {p.modelNumber}</Badge> : null}
              {p.launchDate ? (
                <Badge tone="outline">Launched {formatDate(p.launchDate)}</Badge>
              ) : null}
            </div>
          </div>
          {p.description ? (
            <p className="max-w-3xl text-sm text-muted-foreground">{p.description}</p>
          ) : null}
          {variants.length > 1 ? (
            <div className="max-w-sm">
              <label htmlFor="variant" className="text-sm font-medium">
                Variant
              </label>
              <NativeSelect
                id="variant"
                value={variantId}
                onChange={(e) => setParam("variant", e.target.value)}
                className="mt-1.5"
              >
                {variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {variantSummary(v.attributes).join(" · ") || v.variantKey}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : variant ? (
            <p className="text-sm">{variantSummary(variant.attributes).join(" · ")}</p>
          ) : null}
          {variantId ? (
            <div className="flex flex-wrap gap-2">
              <WatchlistButton variantId={variantId} size="default" />
              <PriceAlertDialog
                variantId={variantId}
                currentPricePaise={best?.pricing.prices.deliveredPaise ?? null}
                sources={sources}
                size="default"
              />
              <Button variant="outline" asChild>
                <Link href={`/compare?product=${p.id}&variant=${variantId}`}>
                  <GitCompareArrows aria-hidden className="size-4" /> Compare
                </Link>
              </Button>
            </div>
          ) : null}
        </div>
        {best ? (
          <aside
            aria-label="Current best offer"
            className="flex w-full flex-col gap-3 rounded-xl border border-primary/30 bg-primary-soft/40 p-4 md:w-80"
          >
            <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-primary uppercase">
              <BadgeCheck aria-hidden className="size-4" /> Lowest delivered price
            </p>
            <p className="text-3xl font-semibold tracking-tight tabular">
              {rupees(best.pricing.prices.deliveredPaise)}
            </p>
            <p className="text-sm">
              on <span className="font-medium">{best.offer.source.name}</span>
              {best.offer.source.isSample ? (
                <Badge tone="warning" className="ml-1.5">
                  Sample
                </Badge>
              ) : null}
            </p>
            <DiscountIndicator pricing={best.pricing} />
            <PriceBreakdown pricing={best.pricing} />
            <ObservedAt iso={best.pricing.observedAt} stale={best.offer.isStale} />
          </aside>
        ) : null}
      </section>

      <Card>
        <CardHeader
          title="Marketplace prices"
          description="Delivered price = selling price + shipping + mandatory fees. Conditional offers are listed separately and never assumed."
        />
        {pricing.isPending ? (
          <LoadingRows rows={3} label="Loading prices" />
        ) : pricing.isError ? (
          <ErrorState
            message="Couldn't load current prices."
            onRetry={() => void pricing.refetch()}
          />
        ) : pricing.data.offers.length ? (
          <OfferComparisonTable data={pricing.data} />
        ) : (
          <EmptyState
            icon={HelpCircle}
            title="No current offers"
            description="No active marketplace has a fresh price for this variant right now."
          />
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Price history"
            action={
              <NativeSelect
                aria-label="History period"
                value={String(days)}
                onChange={(e) => setParam("days", e.target.value)}
                className="h-9 w-32"
              >
                {[30, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </NativeSelect>
            }
          />
          {history.isPending ? (
            <Skeleton className="h-64" />
          ) : history.isError ? (
            <ErrorState
              message="Couldn't load price history."
              onRetry={() => void history.refetch()}
            />
          ) : history.data.points.length ? (
            <PriceHistoryChart history={history.data} sourceNames={sourceNames} />
          ) : (
            <EmptyState
              icon={LineChart}
              title="No price history yet"
              description="History builds up as DealMind observes prices over time."
            />
          )}
        </Card>
        <Card>
          <CardHeader title="Price intelligence" />
          {best ? (
            <div className="flex flex-col gap-4 text-sm">
              <HistoryContext pricing={best.pricing} />
              {best.pricing.history.recentDrop ? (
                <p className="flex items-start gap-2 rounded-lg bg-primary-soft px-3 py-2 text-primary">
                  <TrendingDown aria-hidden className="mt-0.5 size-4 shrink-0" />
                  Verified drop of {percent(best.pricing.history.recentDrop.dropBp)} since{" "}
                  {formatDate(best.pricing.history.recentDrop.since)}
                </p>
              ) : null}
              <dl className="grid grid-cols-2 gap-2">
                {best.pricing.history.windows.map((w) => (
                  <div key={w.days} className="rounded-lg bg-muted px-3 py-2">
                    <dt className="text-xs text-muted-foreground">{w.days}-day low</dt>
                    <dd className="font-medium tabular">{rupees(w.lowestPaise)}</dd>
                    <dd className="text-[11px] text-muted-foreground">
                      {Math.floor(w.coverageBp / 100)}% of period observed
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">
                “All-time low” is only claimed with complete price history since launch. Otherwise
                DealMind says “lowest observed” for a specific period.
              </p>
              {best.pricing.benefits.length ? (
                <div>
                  <p className="mb-2 font-medium">Conditional benefits</p>
                  <BenefitList benefits={best.pricing.benefits} />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No current offer to analyse.</p>
          )}
        </Card>
      </div>

      {Object.keys(p.specifications).length ? (
        <Card>
          <CardHeader title="Specifications" description="As published by the marketplace." />
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {Object.entries(p.specifications).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-border py-1.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}

      {p.category ? <RelatedProducts productId={p.id} category={p.category.slug} /> : null}
    </>
  );
}

function RelatedProducts({ productId, category }: { productId: string; category: string }) {
  const q = useProducts({ category, inStock: true, pageSize: 4 });
  const items = (q.data?.items ?? []).filter((x) => x.id !== productId).slice(0, 3);
  if (!items.length) return null;
  return (
    <section aria-labelledby="related" className="flex flex-col gap-3">
      <h2 id="related" className="text-lg font-semibold">
        Related products
      </h2>
      <ul className="grid gap-3 sm:grid-cols-3">
        {items.map((x) => (
          <li key={x.id}>
            <ProductCard product={x} />
          </li>
        ))}
      </ul>
    </section>
  );
}
