"use client";

import { HelpCircle, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { PriceAlertDialog } from "@/components/alerts/price-alert-form";
import { ProductImage } from "@/components/products/product-card";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useWatchlist, useWatchlistMutations } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import { relativeTime, rupees, variantSummary } from "@/lib/format";

export function WatchlistDetailView({ id }: { id: string }) {
  const q = useWatchlist(id);
  const m = useWatchlistMutations();
  if (q.isPending) return <LoadingRows rows={4} label="Loading watchlist" />;
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState icon={HelpCircle} title="Watchlist not found" />
    ) : (
      <ErrorState message="Couldn't load this watchlist." onRetry={() => void q.refetch()} />
    );
  const w = q.data;
  return (
    <>
      <PageHeader
        title={w.name}
        description={`${w.items.length} watched variant${w.items.length === 1 ? "" : "s"} · lowest current price from active marketplaces`}
        actions={
          <Button variant="outline" asChild>
            <Link href="/watchlists">All watchlists</Link>
          </Button>
        }
      />
      {w.items.length ? (
        <ul className="flex flex-col gap-3">
          {w.items.map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]"
            >
              <ProductImage src={i.product.imageUrl} alt="" size={56} />
              <div className="min-w-0 flex-1">
                <Link
                  href={`/products/${i.product.id}?variant=${i.variant.id}`}
                  className="font-medium hover:underline"
                >
                  {i.product.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {variantSummary(i.variant.attributes).join(" · ")} · added{" "}
                  {relativeTime(i.addedAt)}
                </p>
                {i.note ? <p className="mt-1 text-xs">{i.note}</p> : null}
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Lowest now</p>
                <p className="font-semibold tabular">
                  {i.lowestPricePaise !== null ? (
                    rupees(i.lowestPricePaise)
                  ) : (
                    <span className="text-sm font-normal text-muted-foreground">
                      No current offer
                    </span>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <PriceAlertDialog
                  variantId={i.variant.id}
                  currentPricePaise={i.lowestPricePaise}
                  sources={[]}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${i.product.name}`}
                  disabled={m.removeItem.isPending}
                  onClick={() => m.removeItem.mutate({ watchlistId: w.id, itemId: i.id })}
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={Star}
          title="This watchlist is empty"
          description="Use “Watch” on a product or search result to add it."
        />
      )}
    </>
  );
}
