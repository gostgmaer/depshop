"use client";

import { ChevronRight, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { useCategories } from "@/hooks/queries";

export function CategoriesView() {
  const q = useCategories();
  return (
    <>
      <PageHeader
        title="Categories"
        description="Browse the shared catalog by category."
        actions={
          <Button variant="outline" asChild>
            <Link href="/products">All products</Link>
          </Button>
        }
      />
      {q.isPending ? (
        <LoadingRows rows={4} label="Loading categories" />
      ) : q.isError ? (
        <ErrorState message="Couldn't load categories." onRetry={() => void q.refetch()} />
      ) : q.data.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.map((c) => (
            <li
              key={c.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-card)"
            >
              <Link
                href={`/categories/${c.slug}`}
                className="flex items-center justify-between font-medium hover:underline"
              >
                {c.name}
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </Link>
              {c.children.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {c.children.map((ch) => (
                    <li key={ch.id}>
                      <Link
                        href={`/categories/${ch.slug}`}
                        className="inline-block rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                      >
                        {ch.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={LayoutGrid} title="No categories" />
      )}
    </>
  );
}
