"use client";

import { Check, Plus, Star } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/primitives";
import { useWatchlistMutations, useWatchlists } from "@/hooks/queries";
import { errorMessage } from "@/lib/auth-hooks";

/** Adds a variant to one of the user's watchlists (creating "My watchlist" if none exists). */
export function WatchlistButton({
  variantId,
  size = "sm",
}: {
  variantId: string;
  size?: "sm" | "default";
}) {
  const lists = useWatchlists();
  const m = useWatchlistMutations();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function add(watchlistId?: string) {
    setStatus(null);
    try {
      const id = watchlistId ?? (await m.create.mutateAsync("My watchlist")).id;
      await m.addItem.mutateAsync({ watchlistId: id, variantId });
      setStatus({ ok: true, text: "Added to watchlist" });
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    }
  }

  const items = lists.data?.items ?? [];
  const busy = m.addItem.isPending || m.create.isPending;
  return (
    <div className="inline-flex flex-col items-start gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size={size} disabled={busy}>
            {status?.ok ? (
              <Check aria-hidden className="size-4 text-primary" />
            ) : (
              <Star aria-hidden className="size-4" />
            )}
            {busy ? "Adding…" : "Watch"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Add to watchlist</DropdownMenuLabel>
          {items.map((w) => (
            <DropdownMenuItem key={w.id} onSelect={() => void add(w.id)}>
              <Star aria-hidden className="size-4" /> {w.name}
              <span className="ml-auto text-xs text-muted-foreground tabular">{w.itemCount}</span>
            </DropdownMenuItem>
          ))}
          {items.length ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => void add()}>
            <Plus aria-hidden className="size-4" />{" "}
            {items.length ? "New watchlist" : "Create “My watchlist”"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" className={status?.ok ? "text-xs text-primary" : "text-xs text-danger"}>
        {status?.text}
      </span>
    </div>
  );
}
