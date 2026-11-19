"use client";

import { Tag } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DealCard } from "@/components/deals/deal-card";
import { DealSearchBox } from "@/components/deals/deal-search-box";
import { EmptyState, ErrorState, PageHeader, Pagination } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useCategories, useDealPolicy, useDeals } from "@/hooks/queries";
import type { CategoryNode } from "@/types/api";

/** Flattens the category tree into "Parent › Child" options. */
function categoryOptions(nodes: CategoryNode[], prefix = ""): { slug: string; label: string }[] {
  return nodes.flatMap((n) => [
    { slug: n.slug, label: `${prefix}${n.name}` },
    ...categoryOptions(n.children, `${prefix}${n.name} › `),
  ]);
}

/**
 * Public deals (no account needed): discounted products loaded from the stores' deals
 * feeds (and earlier searches), at least the policy's minimum below MRP, in stock and seen
 * recently. Searching here filters the stored deals; no store is contacted. A deal
 * disappears on its own when it ends.
 */
export function DealsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const category = params.get("category") ?? undefined;
  const q = params.get("q")?.trim() || undefined;
  const deals = useDeals({ page, ...(category ? { category } : {}), ...(q ? { q } : {}) });
  const categories = useCategories();
  const policy = useDealPolicy();
  const min = policy.data?.minDiscountPercent;

  const go = (next: { page?: number; category?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.category !== undefined) {
      if (next.category) p.set("category", next.category);
      else p.delete("category");
      p.delete("page");
    }
    if (next.page !== undefined) p.set("page", String(next.page));
    router.push(`${pathname}${p.size ? `?${p}` : ""}`);
  };

  return (
    <>
      <PageHeader
        title={q ? `Deals matching “${q}”` : "Deals"}
        description={`Products currently ${min ? `at least ${min}% ` : ""}below the store's stated MRP, in stock and seen recently. When a deal ends, it disappears from this page.`}
      />
      {/* Keyed by the query so the box shows the current search after navigation. */}
      <DealSearchBox key={q ?? ""} initialQuery={q ?? ""} />
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
        {q ? (
          <Link
            href={category ? `/deals?category=${encodeURIComponent(category)}` : "/deals"}
            className="pb-3 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Clear search
          </Link>
        ) : null}
      </div>
      {deals.isPending ? (
        <LoadingRows rows={4} label="Loading deals" />
      ) : deals.isError ? (
        <ErrorState message="Couldn't load deals." onRetry={() => void deals.refetch()} />
      ) : deals.data.items.length === 0 ? (
        <EmptyState
          icon={Tag}
          title={q ? `No current deals match “${q}”` : "No live deals right now"}
          description={
            q
              ? "Try fewer or different words, or another category. New deals are loaded from the stores regularly."
              : "Deals are loaded from the connected stores regularly. Check back soon."
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
