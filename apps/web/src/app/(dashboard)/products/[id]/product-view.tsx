"use client";

import { BadgeCheck, GitCompareArrows, HelpCircle, TrendingDown } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OfferComparisonTable } from "@/components/offers/offer-comparison-table";
import {
  BenefitList,
  DiscountIndicator,
  HistoryContext,
  ObservedAt,
  PriceBreakdown,
} from "@/components/offers/pricing-parts";
import {
  type PeriodValue,
  PriceHistoryPanel,
  isPeriod,
} from "@/components/products/price-history-panel";
import { ProductCard, ProductImage } from "@/components/products/product-card";
import { RecommendationsCard } from "@/components/products/recommendations";
import { TrackingPanel } from "@/components/products/tracking-panel";
import { compareHref } from "@/components/search/compare-selection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/misc";
import { Checkbox, Label } from "@/components/ui/primitives";
import { LoadingRows, Skeleton } from "@/components/ui/skeleton";
import { useProduct, useProductPricing, useProducts } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDate, percent, rupees, variantSummary } from "@/lib/format";
import { compareSpecs } from "@/lib/spec-groups";
import { cn } from "@/lib/utils";
import type { ProductDetail } from "@/types/api";

export function ProductView({ id }: { id: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const product = useProduct(id);
  const variants = product.data?.variants ?? [];
  const requested = params.get("variant");
  const variantId =
    requested && variants.some((v) => v.id === requested) ? requested : variants[0]?.id;
  const includeStale = params.get("stale") === "1";
  const periodParam = params.get("period");
  const period: PeriodValue = isPeriod(periodParam) ? periodParam : "90";
  const historySource = params.get("src") ?? "all";
  const showMrp = params.get("mrp") === "1";
  const pricing = useProductPricing(id, variantId, includeStale);

  const setParams = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    const s = p.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  if (product.isPending)
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading product…</span>
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
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
      <ErrorState message={errorMessage(product.error)} onRetry={() => void product.refetch()} />
    );

  const p = product.data;
  const offers = pricing.data?.offers ?? [];
  const best = offers.find((o) => o.offer.id === pricing.data?.comparison.cheapestDelivered);
  const sourceNames = Object.fromEntries(
    offers.map((o) => [o.offer.source.slug, o.offer.source.name]),
  );
  const sources = [
    ...new Map(
      offers
        .filter((o) => !o.offer.isStale)
        .map((o) => [o.offer.source.id, { id: o.offer.source.id, name: o.offer.source.name }]),
    ).values(),
  ];
  const variant = variants.find((v) => v.id === variantId);
  const variantLabel = variant ? variantSummary(variant.attributes).join(" · ") : "";

  return (
    <>
      <section
        aria-label="Product overview"
        className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 shadow-(--shadow-card) md:flex-row"
      >
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
              {p.modelNumber ? (
                <Badge tone="outline">Model {p.modelNumber}</Badge>
              ) : (
                <Badge tone="neutral">Model not stated</Badge>
              )}
              {p.launchDate ? (
                <Badge tone="outline">Launched {formatDate(p.launchDate)}</Badge>
              ) : null}
            </div>
          </div>
          {p.description ? (
            <p className="max-w-3xl text-sm text-muted-foreground">{p.description}</p>
          ) : null}
          {variants.length > 1 ? (
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">
                Variant{" "}
                <span className="font-normal text-muted-foreground">
                  ({variants.length} available)
                </span>
              </legend>
              <div className="flex flex-wrap gap-2">
                {variants.map((v) => {
                  const on = v.id === variantId;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setParams({ variant: v.id, src: null })}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
                        on
                          ? "border-primary bg-primary-soft font-medium text-foreground"
                          : "border-border hover:bg-muted",
                      )}
                    >
                      {variantSummary(v.attributes).join(" · ") || v.variantKey}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ) : variant ? (
            <p className="text-sm">{variantLabel}</p>
          ) : null}
          {variantId ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild>
                <Link href={compareHref([{ productId: p.id, variantId }])}>
                  <GitCompareArrows aria-hidden className="size-4" /> Compare with other products
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
        ) : pricing.isSuccess ? (
          <aside className="w-full rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground md:w-80">
            No marketplace has a current price for this variant.
          </aside>
        ) : null}
      </section>

      {pricing.data ? <RecommendationsCard data={pricing.data.recommendations} /> : null}

      <Card>
        <CardHeader
          title="Marketplace comparison"
          description="Delivered price = selling price + shipping + mandatory fees. Conditional offers are listed separately and never deducted."
          action={
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-stale"
                checked={includeStale}
                onCheckedChange={(c) => setParams({ stale: c === true ? "1" : null })}
              />
              <Label htmlFor="show-stale" className="text-xs font-normal">
                Include offers not seen recently
              </Label>
            </div>
          }
        />
        {pricing.isPending ? (
          <LoadingRows rows={3} label="Loading prices" />
        ) : pricing.isError ? (
          <ErrorState
            message={errorMessage(pricing.error)}
            onRetry={() => void pricing.refetch()}
          />
        ) : offers.length ? (
          <OfferComparisonTable data={pricing.data} />
        ) : (
          <EmptyState
            icon={HelpCircle}
            title="No current offers"
            description={
              includeStale
                ? "No marketplace has ever listed a price for this variant."
                : "No active marketplace has a price for this variant observed in the last 24 hours. Include offers not seen recently to see last-known prices."
            }
          />
        )}
      </Card>

      <PriceHistoryPanel
        productId={p.id}
        variantId={variantId}
        period={period}
        source={historySource}
        showMrp={showMrp}
        defaultSource={best?.offer.source.slug ?? null}
        sourceNames={sourceNames}
        onChange={(n) =>
          setParams({
            ...(n.period ? { period: n.period === "90" ? null : n.period } : {}),
            ...(n.source !== undefined
              ? { src: n.source === "all" ? null : n.source, mrp: null }
              : {}),
            ...(n.mrp !== undefined ? { mrp: n.mrp ? "1" : null } : {}),
          })
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Verified price claims"
            description={best ? `For the best offer (${best.offer.source.name}).` : undefined}
          />
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
                    <dd className="text-xs text-muted-foreground">
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
                  <p className="mb-2 font-medium">Conditional offers (not discounts)</p>
                  <BenefitList benefits={best.pricing.benefits} />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No current offer to analyse.</p>
          )}
        </Card>
        {variantId ? (
          <TrackingPanel
            variantId={variantId}
            variantLabel={variantLabel}
            currentPricePaise={best?.pricing.prices.deliveredPaise ?? null}
            sources={sources}
          />
        ) : null}
      </div>

      <Specifications product={p} variantId={variantId} />

      {p.category ? <RelatedProducts productId={p.id} category={p.category.slug} /> : null}
    </>
  );
}

function Specifications({
  product,
  variantId,
}: {
  product: ProductDetail;
  variantId: string | undefined;
}) {
  const variant = product.variants.find((v) => v.id === variantId);
  const groups = compareSpecs(
    [{ ...product.specifications, ...(variant?.attributes ?? {}) }],
    product.category?.slug ?? null,
  );
  return (
    <Card>
      <CardHeader
        title="Specifications"
        description="Only what the marketplace data states, grouped for this category. Nothing is filled in."
      />
      {groups.length ? (
        <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`spec-${g.id}`}>
              <h3 id={`spec-${g.id}`} className="mb-1.5 text-sm font-semibold">
                {g.label}
              </h3>
              <dl className="text-sm">
                {g.rows.map((r) => (
                  <div
                    key={r.key}
                    className="flex justify-between gap-3 border-b border-border py-1.5"
                  >
                    <dt className="text-muted-foreground">{r.label}</dt>
                    <dd className="text-right">{r.values[0]}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No specifications are stated for this product.
        </p>
      )}
    </Card>
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
