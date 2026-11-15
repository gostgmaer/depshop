"use client";

import { Plus, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/primitives";
import { LoadingRows } from "@/components/ui/skeleton";
import { useUsage, useWatchlistMutations, useWatchlists } from "@/hooks/queries";
import { errorMessage } from "@/lib/auth-hooks";
import { relativeTime } from "@/lib/format";

export function WatchlistsView() {
  const lists = useWatchlists();
  const usage = useUsage();
  const m = useWatchlistMutations();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<{ id: string; name: string } | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await m.create.mutateAsync(name.trim());
      setName("");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Watchlists"
        description={
          usage.data
            ? `${usage.data.watchlists.used} of ${usage.data.watchlists.limit} watchlists on your plan.`
            : "Follow the prices of products you care about."
        }
      />
      <form
        onSubmit={(e) => void create(e)}
        className="flex max-w-lg gap-2"
        aria-label="Create a watchlist"
      >
        <label htmlFor="wl-name" className="sr-only">
          Watchlist name
        </label>
        <Input
          id="wl-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New watchlist, e.g. Diwali phones"
          maxLength={80}
        />
        <Button type="submit" disabled={!name.trim() || m.create.isPending}>
          <Plus aria-hidden className="size-4" /> Create
        </Button>
      </form>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {lists.isPending ? (
        <LoadingRows rows={3} label="Loading watchlists" />
      ) : lists.isError ? (
        <ErrorState message="Couldn't load watchlists." onRetry={() => void lists.refetch()} />
      ) : lists.data.items.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {lists.data.items.map((w) => (
            <li
              key={w.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-card)"
            >
              <Star aria-hidden className="size-5 text-warning" />
              <Link href={`/watchlists/${w.id}`} className="min-w-0 flex-1 hover:underline">
                <span className="block truncate font-medium">{w.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {w.itemCount} item{w.itemCount === 1 ? "" : "s"} · updated{" "}
                  {relativeTime(w.updatedAt)}
                </span>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${w.name}`}
                onClick={() => setToDelete({ id: w.id, name: w.name })}
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={Star}
          title="No watchlists yet"
          description="Create one, or use “Watch” on any product."
        />
      )}
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title={`Delete “${toDelete?.name ?? ""}”?`}
        description="The watchlist and its items are removed. Price alerts you created stay in Alerts."
        confirmLabel="Delete watchlist"
        pending={m.remove.isPending}
        onConfirm={() => {
          if (!toDelete) return;
          m.remove.mutate(toDelete.id, {
            onSuccess: () => setToDelete(null),
            onError: (err) => {
              setToDelete(null);
              setError(errorMessage(err));
            },
          });
        }}
      />
    </>
  );
}
