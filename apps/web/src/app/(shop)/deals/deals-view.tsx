"use client";

import { Clock, FlaskConical, Store, Tag } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ProductImage } from "@/components/products/product-card";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, PageHeader, Pagination } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useCategories, useDeals } from "@/hooks/queries";
import { percent, relativeTime, rupees, variantSummary } from "@/lib/format";
import type { CategoryNode, Deal } from "@/types/api";

/** Flattens the category tree into "Parent › Child" options. */
function categoryOptions(nodes: CategoryNode[], prefix = ""): { slug: string; label: string }[] {
  return nodes.flatMap((n) => [
    { slug: n.slug, label: `${prefix}${n.name}` },
    ...categoryOptions(n.children, `${prefix}${n.name} › `),
  ]);
}

/**
 * Public deals (no account needed). Built only from products DealMind has already
 * fetched, so browsing never triggers marketplace requests. A deal disappears on its
 * own when it closes: no current offer, out of stock, removed, or no longer below MRP.
 */
export function DealsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const category = params.get("category") ?? undefined;
  const deals = useDeals({ page, ...(category ? { category } : {}) });
  const categories = useCategories();

  const go = (next: { page?: number; category?: string | null }) => {
    const q = new URLSearchParams(params);
    if (next.category !== undefined) {
      if (next.category) q.set("category", next.category);
      else q.delete("category");
      q.delete("page");
    }
    if (next.page !== undefined) q.set("page", String(next.page));
    router.push(`${pathname}${q.size ? `?${q}` : ""}`);
  };

  return (
    <>
      <PageHeader
        title="Deals"
        description="Products we've already found that are currently priced below the marketplace's stated MRP, in stock and seen recently. When a deal ends, it disappears from this page."
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Category</span>
          <select
            className="h-11 min-w-56 rounded-lg border border-border bg-surface px-3"
            value={category ?? ""}
            onChange={(e) => go({ category: e.target.value || null })}
          >
            <option value="">All categories</option>
            {categoryOptions(categories.data ?? []).map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {deals.isPending ? (
        <LoadingRows rows={4} label="Loading deals" />
      ) : deals.isError ? (
        <ErrorState message="Couldn't load deals." onRetry={() => void deals.refetch()} />
      ) : deals.data.items.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No live deals right now"
          description={
            <>
              Deals appear here from products DealMind has already found. Try a{" "}
              <Link
                href="/search"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                search
              </Link>{" "}
              to look across marketplaces.
            </>
          }
        />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Deals">
            {deals.data.items.map((d) => (
              <DealCard key={d.variantId} deal={d} />
            ))}
          </ul>
          <Pagination meta={deals.data.pagination} onPage={(p) => go({ page: p })} />
        </>
      )}
    </>
  );
}

function DealCard({ deal: d }: { deal: Deal }) {
  const variant = variantSummary(d.attributes).join(" · ");
  return (
    <li>
      <Card className="flex h-full flex-col gap-3">
        <div className="flex gap-3">
          <ProductImage src={d.imageUrl} alt={d.name} size={72} />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {d.brand}
              {d.category ? ` · ${d.category.name}` : ""}
            </p>
            <h2 className="font-medium">
              <Link
                href={`/products/${d.productId}`}
                className="underline-offset-4 hover:underline"
              >
                {d.name}
              </Link>
            </h2>
            {variant ? <p className="text-xs text-muted-foreground">{variant}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-xl font-semibold tabular">{rupees(d.offer.sellingPricePaise)}</span>
          <span className="text-sm text-muted-foreground line-through tabular">
            {rupees(d.offer.mrpPaise)}
          </span>
          <Badge tone="success">{percent(d.offer.discountBp)} off MRP</Badge>
        </div>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          <li className="flex items-center gap-1.5">
            <Store aria-hidden className="size-3.5" />
            {d.offer.sourceName}
            {d.offerCount > 1 ? ` · deal at ${d.offerCount} stores` : ""}
          </li>
          <li className="flex items-center gap-1.5">
            <Clock aria-hidden className="size-3.5" />
            Price seen {relativeTime(d.offer.observedAt)}
            {d.offer.shippingPaise === null
              ? " · shipping not stated"
              : d.offer.shippingPaise > 0
                ? ` · + ${rupees(d.offer.shippingPaise)} shipping`
                : " · free shipping"}
          </li>
        </ul>
        {d.offer.isSample ? (
          <Badge tone="warning" className="self-start">
            <FlaskConical aria-hidden className="size-3" /> Sample data (mock store)
          </Badge>
        ) : null}
      </Card>
    </li>
  );
}
