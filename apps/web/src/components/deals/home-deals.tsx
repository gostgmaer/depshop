"use client";

import { Tag } from "lucide-react";
import Link from "next/link";
import { DealCard } from "@/components/deals/deal-card";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useDealPolicy, useDeals } from "@/hooks/queries";

/** The deepest current deals, for the home page (stored products only). */
export function HomeDeals({ count = 6 }: { count?: number }) {
  const deals = useDeals({ page: 1, pageSize: count });
  const policy = useDealPolicy();
  const min = policy.data?.minDiscountPercent;
  return (
    <section aria-labelledby="top-deals-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="top-deals-heading" className="text-2xl font-semibold tracking-tight">
            Top deals right now
          </h2>
          <p className="text-sm text-muted-foreground">
            {min ? `At least ${min}% below MRP, ` : ""}in stock and seen recently. Biggest discounts
            first.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/deals">See all deals</Link>
        </Button>
      </div>
      {deals.isPending ? (
        <LoadingRows rows={3} label="Loading deals" />
      ) : deals.isError ? (
        <ErrorState message="Couldn't load deals." onRetry={() => void deals.refetch()} />
      ) : deals.data.items.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No live deals right now"
          description="Deals are loaded from the connected stores regularly. Check back soon."
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Top deals">
          {deals.data.items.map((d) => (
            <DealCard key={d.variantId} deal={d} headingLevel={3} />
          ))}
        </ul>
      )}
    </section>
  );
}
