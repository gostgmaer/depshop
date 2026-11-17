"use client";

import { GitCompareArrows, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { MultiCompare, compareHref, parseCompareItems } from "@/components/compare/multi-compare";
import { OfferComparisonTable } from "@/components/offers/offer-comparison-table";
import { ProductImage } from "@/components/products/product-card";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, NativeSelect, PageHeader } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useProduct, useProductPricing, useProducts } from "@/hooks/queries";
import { rupees, variantSummary } from "@/lib/format";

/** Compare one variant across marketplaces (like-for-like only). */
export function CompareView() {
  const params = useSearchParams();
  const router = useRouter();
  const productId = params.get("product");
  const items = params.get("items");
  if (items !== null)
    return (
      <>
        <PageHeader
          title="Compare products"
          description="Specifications, variants, prices, verified discounts, offers, price history and availability side by side."
        />
        <MultiCompare
          items={parseCompareItems(items)}
          onChange={(next) => router.replace(compareHref(next), { scroll: false })}
        />
      </>
    );
  return (
    <>
      <PageHeader
        title="Compare prices"
        description="One variant, every marketplace: delivered price, verified discount, conditional offers and price history side by side."
      />
      {productId ? <Comparison productId={productId} /> : <ProductPicker />}
    </>
  );
}

function ProductPicker() {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useProducts({ q: submitted, inStock: true, pageSize: 8 }, submitted.length >= 2);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(q.trim());
  };
  return (
    <Card>
      <CardHeader title="Choose a product" />
      <form onSubmit={onSubmit} className="flex gap-2" role="search">
        <label htmlFor="compare-q" className="sr-only">
          Product name
        </label>
        <Input
          id="compare-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Galaxy S25"
        />
        <Button type="submit" disabled={q.trim().length < 2}>
          <Search aria-hidden className="size-4" /> Find
        </Button>
      </form>
      <div className="mt-4">
        {!submitted ? (
          <EmptyState
            icon={GitCompareArrows}
            title="Search for a product to compare"
            description="Or use “Compare prices” on any search result."
          />
        ) : results.isPending ? (
          <LoadingRows rows={3} />
        ) : results.isError ? (
          <ErrorState message="Couldn't search products." onRetry={() => void results.refetch()} />
        ) : results.data.items.length ? (
          <ul className="flex flex-col gap-2">
            {results.data.items.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/compare?product=${p.id}`}
                  className="flex items-center gap-3 rounded-lg p-2 hover:bg-muted"
                >
                  <ProductImage src={p.imageUrl} alt="" size={40} />
                  <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                  <span className="text-sm tabular">{rupees(p.lowestPricePaise)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={Search} title="No products found" />
        )}
      </div>
    </Card>
  );
}

function Comparison({ productId }: { productId: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const product = useProduct(productId);
  const variantId = params.get("variant") ?? product.data?.variants[0]?.id;
  const pricing = useProductPricing(productId, variantId);
  if (product.isPending) return <LoadingRows rows={3} label="Loading product" />;
  if (product.isError)
    return (
      <ErrorState message="Couldn't load this product." onRetry={() => void product.refetch()} />
    );
  const p = product.data;
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <ProductImage src={p.imageUrl} alt="" size={56} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{p.brand}</p>
          <h2 className="font-semibold">
            <Link
              href={`/products/${p.id}${variantId ? `?variant=${variantId}` : ""}`}
              className="hover:underline"
            >
              {p.name}
            </Link>
          </h2>
        </div>
        {p.variants.length > 1 ? (
          <div className="w-full sm:w-72">
            <label htmlFor="cmp-variant" className="text-sm font-medium">
              Variant
            </label>
            <NativeSelect
              id="cmp-variant"
              className="mt-1"
              value={variantId}
              onChange={(e) =>
                router.replace(`/compare?product=${p.id}&variant=${e.target.value}`, {
                  scroll: false,
                })
              }
            >
              {p.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {variantSummary(v.attributes).join(" · ") || v.variantKey}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <Button variant="ghost" size="sm" asChild>
          <Link href="/compare">Change product</Link>
        </Button>
      </div>
      {pricing.isPending ? (
        <LoadingRows rows={3} label="Loading prices" />
      ) : pricing.isError ? (
        <ErrorState message="Couldn't load prices." onRetry={() => void pricing.refetch()} />
      ) : pricing.data.offers.length ? (
        <>
          <OfferComparisonTable data={pricing.data} surface="compare" />
          {pricing.data.comparison.notes.length ? (
            <ul className="mt-3 text-xs text-muted-foreground">
              {pricing.data.comparison.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <EmptyState icon={GitCompareArrows} title="No current offers for this variant" />
      )}
    </Card>
  );
}
