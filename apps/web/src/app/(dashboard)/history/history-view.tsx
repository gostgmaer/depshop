"use client";

import { History } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { SearchRow } from "@/components/dashboard/widgets";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader, Pagination } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useSearches } from "@/hooks/queries";

export function HistoryView() {
  const [page, setPage] = useState(1);
  const q = useSearches(page);
  return (
    <>
      <PageHeader
        title="Search history"
        description="Only you can see your searches."
        actions={
          <Button variant="ai" asChild>
            <Link href="/search">New search</Link>
          </Button>
        }
      />
      {q.isPending ? (
        <LoadingRows rows={5} label="Loading search history" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load your search history." onRetry={() => void q.refetch()} />
      ) : q.data.items.length ? (
        <div className="rounded-xl border border-border bg-surface p-2 shadow-(--shadow-card)">
          <ul className="flex flex-col">
            {q.data.items.map((s) => (
              <SearchRow key={s.id} s={s} />
            ))}
          </ul>
          <div className="px-2 pt-2">
            <Pagination meta={q.data.pagination} onPage={setPage} />
          </div>
        </div>
      ) : (
        <EmptyState
          icon={History}
          title="No searches yet"
          description="Searches you run appear here."
        />
      )}
    </>
  );
}
