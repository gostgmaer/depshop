"use client";

import { parseRupeesToPaise } from "@dealmind/shared";
import { PackageSearch } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useMemo } from "react";
import { ProductCard } from "@/components/products/product-card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, NativeSelect, PageHeader, Pagination } from "@/components/ui/misc";
import { Checkbox, Label } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { useProducts } from "@/hooks/queries";
import type { ProductQuery } from "@/services";

const SORTS = [
  ["relevance", "Relevance"],
  ["price_asc", "Price: low to high"],
  ["price_desc", "Price: high to low"],
  ["newest", "Newest launches"],
  ["name", "Name"],
] as const;

function rupeesParam(v: string | null): number | undefined {
  if (!v) return undefined;
  try {
    return parseRupeesToPaise(v);
  } catch {
    return undefined;
  }
}

export function ProductsView({
  title = "Products",
  fixedCategory,
}: {
  title?: string;
  fixedCategory?: string;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query: ProductQuery = useMemo(() => {
    const min = rupeesParam(params.get("min"));
    const max = rupeesParam(params.get("max"));
    return {
      ...(params.get("q") ? { q: params.get("q")! } : {}),
      ...(fixedCategory || params.get("category")
        ? { category: fixedCategory ?? params.get("category")! }
        : {}),
      ...(params.get("brand") ? { brand: params.get("brand")! } : {}),
      ...(min !== undefined ? { minPricePaise: min } : {}),
      ...(max !== undefined ? { maxPricePaise: max } : {}),
      ...(params.get("inStock") === "true" ? { inStock: true } : {}),
      sort: (params.get("sort") as ProductQuery["sort"]) ?? "relevance",
      page: Number(params.get("page") ?? "1") || 1,
      pageSize: 24,
    };
  }, [params, fixedCategory]);
  const products = useProducts(query);

  const update = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    if (!("page" in next)) p.delete("page");
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => {
      const v = f.get(k);
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    update({
      q: text("q"),
      brand: text("brand"),
      min: text("min"),
      max: text("max"),
    });
  };

  return (
    <>
      <PageHeader
        title={title}
        description="The shared DealMind catalog. Prices are the lowest fresh offer from active marketplaces."
      />
      <form
        onSubmit={onSubmit}
        className="grid items-end gap-3 rounded-xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]"
        aria-label="Filter products"
      >
        <Field label="Search">
          {(p) => (
            <Input
              {...p}
              name="q"
              defaultValue={params.get("q") ?? ""}
              placeholder="Name or model"
            />
          )}
        </Field>
        <Field label="Brand">
          {(p) => (
            <Input {...p} name="brand" defaultValue={params.get("brand") ?? ""} placeholder="Any" />
          )}
        </Field>
        <Field label="Min price (₹)">
          {(p) => (
            <Input {...p} name="min" inputMode="decimal" defaultValue={params.get("min") ?? ""} />
          )}
        </Field>
        <Field label="Max price (₹)">
          {(p) => (
            <Input {...p} name="max" inputMode="decimal" defaultValue={params.get("max") ?? ""} />
          )}
        </Field>
        <Button type="submit">Apply</Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="in-stock"
            checked={params.get("inStock") === "true"}
            onCheckedChange={(c) => update({ inStock: c ? "true" : undefined })}
          />
          <Label htmlFor="in-stock" className="font-normal">
            In stock only
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="sort" className="text-sm text-muted-foreground">
            Sort
          </label>
          <NativeSelect
            id="sort"
            value={query.sort}
            onChange={(e) => update({ sort: e.target.value })}
            className="h-9 w-48"
          >
            {SORTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {products.isPending ? (
        <div role="status" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <span className="sr-only">Loading products…</span>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : products.isError ? (
        <ErrorState message="Couldn't load products." onRetry={() => void products.refetch()} />
      ) : products.data.items.length ? (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy={products.isFetching}>
            {products.data.items.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
          <Pagination
            meta={products.data.pagination}
            onPage={(page) => update({ page: String(page) })}
          />
        </>
      ) : (
        <EmptyState
          icon={PackageSearch}
          title="No products match"
          description="Try fewer filters, or use AI Search to look across marketplaces."
        />
      )}
    </>
  );
}
