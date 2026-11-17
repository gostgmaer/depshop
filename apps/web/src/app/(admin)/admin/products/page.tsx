"use client";

import { useQuery } from "@tanstack/react-query";
import { Boxes, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { HealthBadge, TableWrap, num, td, th } from "@/components/admin/admin-ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, PageHeader, Pagination } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/auth-hooks";
import { relativeTime } from "@/lib/format";
import { admin } from "@/services/admin";

export default function AdminProductsPage() {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["admin", "products", page, q],
    queryFn: () => admin.products(page, q || undefined),
  });
  return (
    <>
      <PageHeader
        title="Products"
        description="Canonical catalog. Corrections are audited; marketplace offers and their provenance are never edited here."
      />
      <form
        role="search"
        className="flex max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
          setPage(1);
        }}
      >
        <label htmlFor="product-q" className="sr-only">
          Search products
        </label>
        <Input
          id="product-q"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Name, brand or product id"
          maxLength={100}
        />
        <Button type="submit" variant="outline">
          <Search aria-hidden className="size-4" /> Search
        </Button>
      </form>
      <Card>
        {list.isPending ? (
          <LoadingRows label="Loading products" />
        ) : list.error ? (
          <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={Boxes} title="No products found" />
        ) : (
          <div className="flex flex-col gap-4">
            <TableWrap label="Products">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      Product
                    </th>
                    <th scope="col" className={th}>
                      Category
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      Variants
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      Offers
                    </th>
                    <th scope="col" className={th}>
                      Status
                    </th>
                    <th scope="col" className={th}>
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr key={p.id} className="border-t border-border">
                      <td className={td}>
                        <Link
                          href={`/admin/products/${p.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {p.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{p.brand}</p>
                      </td>
                      <td className={td}>{p.category ?? "—"}</td>
                      <td className={`${td} text-right tabular`}>{num(p.variants)}</td>
                      <td className={`${td} text-right tabular`}>{num(p.offers)}</td>
                      <td className={td}>
                        <HealthBadge value={p.isActive ? "active" : "inactive"} />
                      </td>
                      <td className={`${td} whitespace-nowrap`}>{relativeTime(p.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <Pagination meta={list.data.pagination} onPage={setPage} />
          </div>
        )}
      </Card>
    </>
  );
}
