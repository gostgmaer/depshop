"use client";

/**
 * Side-by-side comparison of 2–4 picked variants. Prices come from the
 * deterministic pricing endpoint per variant; specifications from the shared
 * catalog. Picks are never presented as identical unless they are the same
 * variant: different variants of one product and different products are
 * labelled as such above the table and in each column.
 */
import { useQueries } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import Link from "next/link";
import { specLabel as keyLabel, specValueLabel } from "@dealmind/shared";
import { StockBadge } from "@/components/offers/pricing-parts";
import { ProductImage } from "@/components/products/product-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { keys } from "@/hooks/queries";
import { formatDate, rupees, variantSummary } from "@/lib/format";
import { catalog } from "@/services";
import type { ProductDetail, ProductPricingView } from "@/types/api";
import { compareHref } from "@/components/search/compare-selection";

export interface CompareItem {
  productId: string;
  variantId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "pid:vid,pid:vid" → unique, valid picks (at most 4). */
export function parseCompareItems(raw: string | null): CompareItem[] {
  const out: CompareItem[] = [];
  for (const part of (raw ?? "").split(",")) {
    const [productId, variantId] = part.split(":");
    if (!productId || !variantId || !UUID.test(productId) || !UUID.test(variantId)) continue;
    if (!out.some((o) => o.variantId === variantId)) out.push({ productId, variantId });
  }
  return out.slice(0, 4);
}

export type Relation = "same_variant" | "different_variant" | "different_product";

/** How each pick relates to the others, so nothing is shown as identical when it isn't. */
export function compareRelations(items: CompareItem[]): {
  relation: Relation[];
  notes: string[];
} {
  const byProduct = new Map<string, Set<string>>();
  for (const i of items) {
    const set = byProduct.get(i.productId) ?? new Set<string>();
    set.add(i.variantId);
    byProduct.set(i.productId, set);
  }
  const relation = items.map((i): Relation =>
    byProduct.size === 1 && byProduct.get(i.productId)!.size === 1
      ? "same_variant"
      : byProduct.get(i.productId)!.size > 1
        ? "different_variant"
        : "different_product",
  );
  const notes: string[] = [];
  if ([...byProduct.values()].some((v) => v.size > 1))
    notes.push(
      "Some picks are different variants of the same product (for example different RAM, storage or colour). They are different configurations, not the same item, so their prices aren't like-for-like.",
    );
  if (byProduct.size > 1)
    notes.push(
      "These are different products. Compare specifications as well as prices: a lower price may mean a lower specification.",
    );
  return { relation, notes };
}

const RELATION_LABEL: Record<Relation, string> = {
  same_variant: "Same variant",
  different_variant: "Different variant",
  different_product: "Different product",
};

interface Column {
  item: CompareItem;
  product: ProductDetail;
  pricing: ProductPricingView;
}

function cheapest(c: Column) {
  return c.pricing.offers[0] ?? null;
}

/** Specification keys stated by any picked product or variant, in a stable order. */
function specKeys(cols: Column[]): string[] {
  const keys = new Set<string>();
  for (const c of cols) {
    const v = c.product.variants.find((x) => x.id === c.item.variantId);
    for (const k of Object.keys(v?.attributes ?? {})) keys.add(k);
    for (const [k, val] of Object.entries(c.product.specifications))
      if (typeof val === "string" || typeof val === "number") keys.add(k);
  }
  keys.delete("color_family");
  return [...keys].sort();
}

function specValue(c: Column, key: string): string | null {
  const v = c.product.variants.find((x) => x.id === c.item.variantId);
  const value = v?.attributes[key] ?? c.product.specifications[key];
  return typeof value === "string" || typeof value === "number" ? specValueLabel(key, value) : null;
}

export function MultiCompare({ items }: { items: CompareItem[] }) {
  const products = useQueries({
    queries: items.map((i) => ({
      queryKey: keys.product(i.productId),
      queryFn: () => catalog.product(i.productId),
    })),
  });
  const prices = useQueries({
    queries: items.map((i) => ({
      queryKey: keys.pricing(i.productId, i.variantId),
      queryFn: () => catalog.pricing(i.productId, i.variantId),
      staleTime: 30_000,
    })),
  });

  if (items.length < 2)
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Pick at least two products"
        description="Select “Compare” on two to four search results."
      />
    );
  if ([...products, ...prices].some((q) => q.isPending))
    return <LoadingRows rows={4} label="Loading comparison" />;
  const failed = [...products, ...prices].find((q) => q.isError);
  if (failed)
    return (
      <ErrorState
        message="Couldn't load every product to compare."
        onRetry={() => [...products, ...prices].forEach((q) => void q.refetch())}
      />
    );

  const cols: Column[] = items.map((item, i) => ({
    item,
    product: products[i]!.data!,
    pricing: prices[i]!.data!,
  }));
  const { relation, notes } = compareRelations(items);
  const specs = specKeys(cols);
  const without = (variantId: string) =>
    compareHref(items.filter((i) => i.variantId !== variantId));

  const row = (label: string, render: (c: Column) => React.ReactNode, differs?: boolean) => (
    <tr className="border-t border-border align-top">
      <th scope="row" className="py-2.5 pr-3 text-left text-xs font-medium text-muted-foreground">
        {label}
        {differs ? <span className="sr-only"> (differs)</span> : null}
      </th>
      {cols.map((c) => (
        <td key={c.item.variantId} className="min-w-44 px-3 py-2.5 text-sm">
          {render(c)}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="flex flex-col gap-4">
      {notes.length ? (
        <ul className="flex flex-col gap-1.5" aria-label="Comparison notes">
          {notes.map((n) => (
            <li
              key={n}
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
            >
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> {n}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Side-by-side comparison of the selected products</caption>
          <thead>
            <tr>
              <td className="w-36 p-3" />
              {cols.map((c, i) => (
                <th key={c.item.variantId} scope="col" className="min-w-44 p-3 align-top">
                  <div className="flex items-start justify-between gap-2">
                    <ProductImage src={c.product.imageUrl} alt="" size={48} />
                    {cols.length > 2 ? (
                      <Button variant="ghost" size="icon" asChild>
                        <Link
                          href={without(c.item.variantId)}
                          aria-label={`Remove ${c.product.name}`}
                        >
                          <X aria-hidden className="size-4" />
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs font-normal text-muted-foreground">
                    {c.product.brand}
                  </p>
                  <Link
                    href={`/products/${c.product.id}?variant=${c.item.variantId}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {c.product.name}
                  </Link>
                  <div className="mt-1">
                    <Badge tone={relation[i] === "same_variant" ? "success" : "warning"}>
                      {RELATION_LABEL[relation[i]!]}
                    </Badge>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row("Variant", (c) => {
              const v = c.product.variants.find((x) => x.id === c.item.variantId);
              const parts = variantSummary(v?.attributes ?? {});
              return parts.length ? (
                parts.join(" · ")
              ) : (
                <span className="text-muted-foreground">Not stated</span>
              );
            })}
            {row("Lowest delivered price", (c) => {
              const o = cheapest(c);
              return o ? (
                <span>
                  <span className="text-base font-semibold tabular">
                    {rupees(o.pricing.prices.deliveredPaise)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    at {o.offer.source.name}
                    {o.offer.source.isSample ? " (sample data)" : ""}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">No current offer</span>
              );
            })}
            {row("Verified direct discount", (c) => {
              const d = cheapest(c)?.pricing.directDiscount;
              if (!d) return <span className="text-muted-foreground">—</span>;
              if (d.status === "OK" && d.percentBp)
                return (
                  <span className="text-primary">
                    {d.percentText} off MRP {rupees(d.mrpPaise)}
                  </span>
                );
              return (
                <span className="text-muted-foreground">
                  {d.status === "NO_MRP"
                    ? "MRP not stated"
                    : d.status === "OK"
                      ? "No discount"
                      : "MRP not verified"}
                </span>
              );
            })}
            {row("Marketplace offers", (c) =>
              c.pricing.offers.length ? (
                <ul className="flex flex-col gap-0.5 text-xs">
                  {c.pricing.offers.slice(0, 4).map((o) => (
                    <li key={o.offer.id} className="flex justify-between gap-2 tabular">
                      <span className="truncate">{o.offer.source.name}</span>
                      <span>{rupees(o.pricing.prices.deliveredPaise)}</span>
                    </li>
                  ))}
                  {c.pricing.offers.length > 4 ? (
                    <li className="text-muted-foreground">+{c.pricing.offers.length - 4} more</li>
                  ) : null}
                </ul>
              ) : (
                <span className="text-muted-foreground">None current</span>
              ),
            )}
            {row("Conditional offers", (c) => {
              const n =
                cheapest(c)?.pricing.benefits.filter((b) => b.status !== "EXPIRED").length ?? 0;
              return n ? (
                <span className="text-warning">{n} conditional · not guaranteed</span>
              ) : (
                <span className="text-muted-foreground">None stated</span>
              );
            })}
            {row("Price history", (c) => {
              const h = cheapest(c)?.pricing.history;
              return (
                <span className="text-xs">
                  {h?.lowestClaim.text ??
                    (h && h.observations < 3
                      ? "Not enough history yet"
                      : "Not the lowest observed price")}
                </span>
              );
            })}
            {row("Availability", (c) => {
              const o = cheapest(c);
              const inStock = c.pricing.offers.filter((x) =>
                ["IN_STOCK", "LIMITED"].includes(x.offer.stockStatus),
              ).length;
              return o ? (
                <span className="flex flex-col items-start gap-1">
                  <StockBadge status={o.offer.stockStatus} />
                  <span className="text-xs text-muted-foreground">
                    In stock at {inStock} of {c.pricing.offers.length}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">Unknown</span>
              );
            })}
            {row("Launch date", (c) =>
              c.product.launchDate ? (
                formatDate(c.product.launchDate)
              ) : (
                <span className="text-muted-foreground">Not stated</span>
              ),
            )}
            {specs.map((k) => {
              const values = cols.map((c) => specValue(c, k));
              const differs = new Set(values.map((v) => v ?? "")).size > 1;
              return (
                <tr key={k} className="border-t border-border align-top">
                  <th
                    scope="row"
                    className="py-2.5 pr-3 text-left text-xs font-medium text-muted-foreground"
                  >
                    {keyLabel(k)}
                    {differs ? <span className="sr-only"> (differs)</span> : null}
                  </th>
                  {cols.map((c, i) => (
                    <td
                      key={c.item.variantId}
                      className={`min-w-44 px-3 py-2.5 text-sm ${differs ? "font-medium" : ""}`}
                    >
                      {values[i] ?? (
                        <span className="font-normal text-muted-foreground">Not stated</span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Prices are current delivered prices (selling + shipping + mandatory fees) from authorized
        sources. Specifications are shown only as the catalog states them; “Not stated” is never
        filled in.
      </p>
    </div>
  );
}
