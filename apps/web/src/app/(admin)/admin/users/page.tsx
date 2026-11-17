"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Search, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { HealthBadge, TableWrap, td, th } from "@/components/admin/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/misc";
import { LoadingRows } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDate } from "@/lib/format";
import { admin } from "@/services/admin";

export default function AdminUsersPage() {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const list = useInfiniteQuery({
    queryKey: ["admin", "users", q],
    queryFn: ({ pageParam }) => admin.users(q || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title="Users"
        description="Search by email, name or user id. Credentials are never shown."
      />
      <form
        role="search"
        className="flex max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <label htmlFor="user-q" className="sr-only">
          Search users
        </label>
        <Input
          id="user-q"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Email, name or id"
          maxLength={100}
        />
        <Button type="submit" variant="outline">
          <Search aria-hidden className="size-4" /> Search
        </Button>
      </form>
      <Card>
        {list.isPending ? (
          <LoadingRows label="Loading users" />
        ) : list.error ? (
          <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title="No users found" />
        ) : (
          <>
            <TableWrap label="Users">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      User
                    </th>
                    <th scope="col" className={th}>
                      Role
                    </th>
                    <th scope="col" className={th}>
                      Status
                    </th>
                    <th scope="col" className={th}>
                      Joined
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id} className="border-t border-border">
                      <td className={td}>
                        <Link
                          href={`/admin/users/${u.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {u.email}
                        </Link>
                        <p className="text-xs text-muted-foreground">{u.name}</p>
                      </td>
                      <td className={td}>
                        <Badge tone={u.role === "ADMIN" ? "ai" : "neutral"}>
                          {u.role === "ADMIN" ? "Admin" : "User"}
                        </Badge>
                      </td>
                      <td className={td}>
                        <HealthBadge value={u.status} />
                      </td>
                      <td className={`${td} whitespace-nowrap`}>{formatDate(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {list.hasNextPage ? (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="outline"
                  disabled={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  {list.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
