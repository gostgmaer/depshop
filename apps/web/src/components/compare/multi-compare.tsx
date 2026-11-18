"use client";

/**
 * Side-by-side comparison of 1–4 picked variants: overview, current prices
 * (per-variant deterministic pricing), verified discounts, offers, historical
 * position, availability and category-grouped specifications. Recommendations
 * across the picks come from GET /compare (affiliate-neutral). Picks are never
 * presented as identical unless they are the same variant, and specifications
 * of different categories are flagged as not directly comparable.
 */
import { formatBasisPoints } from "@dealmind/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type ReactNode, useState } from "react";
import { StockBadge } from "@/components/offers/pricing-parts";
import { ProductImage } from "@/components/products/product-card";
import { RecommendationsCard } from "@/components/products/recommendations";
import { compareHref } from "@/components/search/compare-selection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, NativeSelect } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { keys, useCompare, useProducts } from "@/hooks/queries";
import { useDebounced } from "@/hooks/use-debounced";
import { formatDate, rupees, variantSummary } from "@/lib/format";
import { compareSpecs } from "@/lib/spec-groups";
import { catalog } from "@/services";
import type { OfferPricingView, ProductDetail, ProductPricingView } from "@/types/api";

export interface CompareItem {
  productId: string;
  variantId: string;
}

export const MAX_ITEMS = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "pid:vid,pid:vid" → unique, valid picks (at most 4). */
export function parseCompareItems(raw: string | null): CompareItem[] {
  const out: CompareItem[] = [];
  for (const part of (raw ?? "").split(",")) {
    const [productId, variantId] = part.split(":");
    if (!productId || !variantId || !UUID.test(productId) || !UUID.test(variantId)) continue;
    if (!out.some((o) => o.variantId === variantId)) out.push({ productId, variantId });
  }
  return out.slice(0, MAX_ITEMS);
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
  relation: Relation;
}

const variantOf = (c: Column) => c.product.variants.find((v) => v.id === c.item.variantId);
const cheapestOf = (c: Column): OfferPricingView | null =>
  c.pricing.offers.find((o) => o.offer.id === c.pricing.comparison.cheapestDelivered) ?? null;

/** Plain-language position of the current price in its own history. */
export function historyPosition(o: OfferPricingView | null): string {
  if (!o) return "No current offer";
  const h = o.pricing.history;
  if (h.lowestClaim.text) return h.lowestClaim.text;
  if (h.changeVs30DayAverageBp !== null && h.changeVs30DayAverageBp !== 0)
    return `${formatBasisPoints(Math.abs(h.changeVs30DayAverageBp))} ${h.changeVs30DayAverageBp < 0 ? "below" : "above"} its 30-day average`;
  return h.observations < 3 ? "Not enough price history yet" : "Near its 30-day average";
}

interface RowDef {
  label: string;
  render: (c: Column) => ReactNode;
}

const ROWS: RowDef[] = [
  { label: "Brand", render: (c) => c.product.brand },
  {
    label: "Model",
    render: (c) => c.product.modelNumber ?? <NotStated />,
  },
  {
    label: "Variant",
    render: (c) => {
      const parts = variantSummary(variantOf(c)?.attributes ?? {});
      return parts.length ? parts.join(" · ") : <NotStated />;
    },
  },
  {
    label: "Category",
    render: (c) => c.product.category?.name ?? <NotStated />,
  },
  {
    label: "Launch date",
    render: (c) => (c.product.launchDate ? formatDate(c.product.launchDate) : <NotStated />),
  },
  {
    label: "Current lowest price",
    render: (c) => {
      const o = cheapestOf(c);
      return o ? (
        <span>
          <span className="text-base font-semibold tabular">
            {rupees(o.pricing.prices.deliveredPaise)}
          </span>
          <span className="block text-xs text-muted-foreground">
            delivered at {o.offer.source.name}
            {o.offer.source.isSample ? " (sample data)" : ""}
          </span>
        </span>
      ) : (
        <span className="text-muted-foreground">No current offer</span>
      );
    },
  },
  {
    label: "Marketplace offers",
    render: (c) => {
      const current = c.pricing.offers.filter((o) => !o.offer.isStale);
      return current.length ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {current.slice(0, 4).map((o) => (
            <li key={o.offer.id} className="flex justify-between gap-2 tabular">
              <span className="truncate">{o.offer.source.name}</span>
              <span>{rupees(o.pricing.prices.deliveredPaise)}</span>
            </li>
          ))}
          {current.length > 4 ? (
            <li className="text-muted-foreground">+{current.length - 4} more</li>
          ) : null}
        </ul>
      ) : (
        <span className="text-muted-foreground">None current</span>
      );
    },
  },
  {
    label: "Direct discount",
    render: (c) => {
      const d = cheapestOf(c)?.pricing.directDiscount;
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
    },
  },
  {
    label: "Conditional offers",
    render: (c) => {
      const n = cheapestOf(c)?.pricing.benefits.filter((b) => b.status !== "EXPIRED").length ?? 0;
      return n ? (
        <span className="text-warning">{n} conditional · not a discount</span>
      ) : (
        <span className="text-muted-foreground">None stated</span>
      );
    },
  },
  {
    label: "Historical price position",
    render: (c) => <span className="text-xs">{historyPosition(cheapestOf(c))}</span>,
  },
  {
    label: "Availability",
    render: (c) => {
      const o = cheapestOf(c);
      const current = c.pricing.offers.filter((x) => !x.offer.isStale);
      const inStock = current.filter((x) =>
        ["IN_STOCK", "LIMITED"].includes(x.offer.stockStatus),
      ).length;
      return o ? (
        <span className="flex flex-col items-start gap-1">
          <StockBadge status={o.offer.stockStatus} />
          <span className="text-xs text-muted-foreground">
            In stock at {inStock} of {current.length}
          </span>
        </span>
      ) : (
        <span className="text-muted-foreground">Unknown</span>
      );
    },
  },
];

function NotStated() {
  return <span className="text-muted-foreground">Not stated</span>;
}

export function MultiCompare({
  items,
  onChange,
}: {
  items: CompareItem[];
  onChange: (next: CompareItem[]) => void;
}) {
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
  const reco = useCompare(items);
  const all = [...products, ...prices];
  const add = (i: CompareItem) =>
    onChange([...items.filter((x) => x.variantId !== i.variantId), i].slice(0, MAX_ITEMS));
  const remove = (variantId: string) => onChange(items.filter((i) => i.variantId !== variantId));

  const picker =
    items.length < MAX_ITEMS ? (
      <ProductPicker onAdd={add} taken={items.map((i) => i.variantId)} />
    ) : null;

  if (!items.length)
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={Search}
          title="Nothing to compare yet"
          description="Add products below, or select “Compare” on search results."
        />
        {picker}
      </div>
    );
  if (all.some((q) => q.isPending)) return <LoadingRows rows={4} label="Loading comparison" />;
  if (all.some((q) => q.isError))
    return (
      <ErrorState
        message="Couldn't load every product to compare. One may no longer be in the catalog."
        onRetry={() => all.forEach((q) => void q.refetch())}
      />
    );

  const { relation, notes } = compareRelations(items);
  const cols: Column[] = items.map((item, i) => ({
    item,
    product: products[i]!.data!,
    pricing: prices[i]!.data!,
    relation: relation[i]!,
  }));
  const categories = [...new Set(cols.map((c) => c.product.category?.slug ?? "uncategorized"))];
  if (categories.length > 1)
    notes.push(
      `These products are in different categories (${[...new Set(cols.map((c) => c.product.category?.name ?? "Uncategorized"))].join(", ")}), so most specifications aren't directly comparable.`,
    );
  const specGroups = compareSpecs(
    cols.map((c) => ({ ...c.product.specifications, ...(variantOf(c)?.attributes ?? {}) })),
    categories.length === 1 ? categories[0] : null,
  );
  const nameOf = (variantId: string | null) => {
    const c = cols.find((x) => x.item.variantId === variantId);
    if (!c) return null;
    const v = variantSummary(variantOf(c)?.attributes ?? {}).join(" · ");
    return v ? `${c.product.name} (${v})` : c.product.name;
  };

  return (
    <div className="flex flex-col gap-5">
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

      {items.length > 1 ? (
        reco.isError ? (
          <ErrorState
            message="Couldn't load recommendations."
            onRetry={() => void reco.refetch()}
          />
        ) : reco.data ? (
          <RecommendationsCard
            title="Best deal across these products"
            data={reco.data.recommendations}
            describe={(r) => nameOf(r.variantId)}
          />
        ) : (
          <LoadingRows rows={1} label="Loading recommendations" />
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          Add another product to compare it side by side.
        </p>
      )}

      {/* Desktop: one table, products as columns. */}
      <div className="relative hidden overflow-x-auto rounded-xl border border-border bg-surface lg:block">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Side-by-side comparison of the selected products</caption>
          <thead>
            <tr>
              <td className="w-44 p-3" />
              {cols.map((c) => (
                <th key={c.item.variantId} scope="col" className="min-w-52 p-3 align-top">
                  <ColumnHead col={c} onRemove={() => remove(c.item.variantId)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.label} className="border-t border-border align-top">
                <th
                  scope="row"
                  className="py-2.5 pr-3 pl-3 text-left text-xs font-medium text-muted-foreground"
                >
                  {r.label}
                </th>
                {cols.map((c) => (
                  <td key={c.item.variantId} className="px-3 py-2.5 text-sm">
                    {r.render(c)}
                  </td>
                ))}
              </tr>
            ))}
            {specGroups.map((g) => (
              <SpecGroupRows key={g.id} group={g} cols={cols.length} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per product. */}
      <ul className="flex flex-col gap-4 lg:hidden" aria-label="Compared products">
        {cols.map((c, i) => (
          <li key={c.item.variantId}>
            <article className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
              <ColumnHead col={c} onRemove={() => remove(c.item.variantId)} />
              <dl className="flex flex-col text-sm">
                {ROWS.map((r) => (
                  <div
                    key={r.label}
                    className="flex justify-between gap-3 border-t border-border py-2"
                  >
                    <dt className="text-xs text-muted-foreground">{r.label}</dt>
                    <dd className="text-right">{r.render(c)}</dd>
                  </div>
                ))}
              </dl>
              {specGroups.map((g) => (
                <section key={g.id} aria-label={g.label}>
                  <h3 className="mt-1 text-xs font-semibold">{g.label}</h3>
                  <dl className="text-sm">
                    {g.rows.map((row) => (
                      <div
                        key={row.key}
                        className="flex justify-between gap-3 border-t border-border py-1.5"
                      >
                        <dt className="text-xs text-muted-foreground">
                          {row.label}
                          {row.differs ? <span className="sr-only"> (differs)</span> : null}
                        </dt>
                        <dd className={row.differs ? "text-right font-medium" : "text-right"}>
                          {row.values[i] ?? <NotStated />}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </article>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        Prices are current delivered prices (selling + shipping + mandatory fees) from authorized
        sources; offers not observed in the last 24 hours are not used. Specifications are shown
        only as the catalog states them; “Not stated” is never filled in, and a value stated by only
        some products is not treated as the same or different.
      </p>
      {picker}
    </div>
  );
}

function ColumnHead({ col, onRemove }: { col: Column; onRemove: () => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <ProductImage src={col.product.imageUrl} alt="" size={48} />
        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove ${col.product.name}`}
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <Link
        href={`/products/${col.product.id}?variant=${col.item.variantId}`}
        className="text-sm font-medium hover:underline"
      >
        {col.product.name}
      </Link>
      <div>
        <Badge tone={col.relation === "same_variant" ? "success" : "warning"}>
          {RELATION_LABEL[col.relation]}
        </Badge>
      </div>
    </div>
  );
}

function SpecGroupRows({
  group,
  cols,
}: {
  group: ReturnType<typeof compareSpecs>[number];
  cols: number;
}) {
  return (
    <>
      <tr className="border-t border-border bg-muted/50">
        <th
          colSpan={cols + 1}
          scope="colgroup"
          className="px-3 py-2 text-left text-xs font-semibold"
        >
          {group.label}
        </th>
      </tr>
      {group.rows.map((r) => (
        <tr key={r.key} className="border-t border-border align-top">
          <th
            scope="row"
            className="py-2.5 pr-3 pl-3 text-left text-xs font-medium text-muted-foreground"
          >
            {r.label}
            {r.differs ? (
              <Badge tone="outline" className="ml-1.5">
                Differs
              </Badge>
            ) : null}
            {r.partial ? (
              <span className="block font-normal">Not stated by every product</span>
            ) : null}
          </th>
          {r.values.map((v, i) => (
            <td key={i} className={`px-3 py-2.5 text-sm ${r.differs && v ? "font-medium" : ""}`}>
              {v ?? <NotStated />}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Search the catalog and add a product's variant to the comparison. */
function ProductPicker({ onAdd, taken }: { onAdd: (item: CompareItem) => void; taken: string[] }) {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 250);
  const results = useProducts({ q: debounced, pageSize: 6 }, debounced.length >= 2);
  const [chosen, setChosen] = useState<string | null>(null);
  const product = useQuery({
    queryKey: keys.product(chosen ?? ""),
    queryFn: () => catalog.product(chosen!),
    enabled: chosen !== null,
  });
  const [variant, setVariant] = useState("");
  const onSubmit = (e: FormEvent) => e.preventDefault();
  const variants = product.data?.variants.filter((v) => !taken.includes(v.id)) ?? [];

  return (
    <Card>
      <CardHeader title="Add a product" description="Up to 4 products or variants." />
      <form onSubmit={onSubmit} role="search" className="flex gap-2">
        <label htmlFor="compare-add-q" className="sr-only">
          Product name
        </label>
        <Input
          id="compare-add-q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setChosen(null);
          }}
          placeholder="e.g. Galaxy S25"
          autoComplete="off"
        />
      </form>
      {chosen ? (
        product.isPending ? (
          <LoadingRows rows={1} label="Loading variants" />
        ) : product.data ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <label htmlFor="compare-add-variant" className="text-sm font-medium">
                Variant of {product.data.name}
              </label>
              <NativeSelect
                id="compare-add-variant"
                className="mt-1"
                value={variant}
                onChange={(e) => setVariant(e.target.value)}
              >
                <option value="">Choose a variant</option>
                {variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {variantSummary(v.attributes).join(" · ") || v.variantKey}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button
              disabled={!variant}
              onClick={() => {
                onAdd({ productId: product.data.id, variantId: variant });
                setChosen(null);
                setVariant("");
                setQ("");
              }}
            >
              <Plus aria-hidden className="size-4" /> Add to comparison
            </Button>
          </div>
        ) : (
          <ErrorState message="Couldn't load this product." />
        )
      ) : debounced.length >= 2 ? (
        results.isPending ? (
          <LoadingRows rows={2} label="Searching products" />
        ) : results.data?.items.length ? (
          <ul className="mt-3 flex flex-col gap-1" aria-label="Matching products">
            {results.data.items.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setChosen(p.id);
                    setVariant("");
                  }}
                  className="flex w-full items-center gap-3 rounded-lg p-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                >
                  <ProductImage src={p.imageUrl} alt="" size={36} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="tabular text-muted-foreground">
                    {p.lowestPricePaise !== null ? rupees(p.lowestPricePaise) : "No current price"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No products match “{debounced}”.</p>
        )
      ) : null}
    </Card>
  );
}

export { compareHref };
