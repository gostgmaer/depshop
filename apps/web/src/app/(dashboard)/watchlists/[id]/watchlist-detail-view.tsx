"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  HelpCircle,
  Minus,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { PriceAlertDialog } from "@/components/alerts/price-alert-form";
import { ProductImage } from "@/components/products/product-card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/primitives";
import { LoadingRows } from "@/components/ui/skeleton";
import { useWatchlist, useWatchlistMutations } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/auth-hooks";
import { percent, relativeTime, rupees, variantSummary } from "@/lib/format";
import type { WatchlistDetail } from "@/types/api";

type Item = WatchlistDetail["items"][number];

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
        description={`${w.items.length} watched product${w.items.length === 1 ? "" : "s"} · lowest delivered price from current, in-stock offers`}
        actions={
          <>
            <RenameDialog id={w.id} name={w.name} />
            <Button variant="outline" asChild>
              <Link href="/watchlists">All watchlists</Link>
            </Button>
          </>
        }
      />
      {m.removeItem.isError ? <Alert tone="error">{errorMessage(m.removeItem.error)}</Alert> : null}
      {w.items.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {w.items.map((i) => (
            <li key={i.id}>
              <ItemCard
                item={i}
                removing={m.removeItem.isPending}
                onRemove={() => m.removeItem.mutate({ watchlistId: w.id, itemId: i.id })}
              />
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

function ItemCard({
  item: i,
  onRemove,
  removing,
}: {
  item: Item;
  onRemove: () => void;
  removing: boolean;
}) {
  const variant = variantSummary(i.variant.attributes).join(" · ");
  return (
    <article
      aria-label={i.product.name}
      className="flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-(--shadow-card)"
    >
      <div className="flex gap-3">
        <ProductImage src={i.product.imageUrl} alt="" size={56} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{i.product.brand}</p>
          <Link
            href={`/products/${i.product.id}?variant=${i.variant.id}`}
            className="font-medium hover:underline"
          >
            {i.product.name}
          </Link>
          {variant ? <p className="text-xs text-muted-foreground">{variant}</p> : null}
        </div>
      </div>
      {i.current ? (
        <div>
          <p className="text-xs text-muted-foreground">Lowest delivered now</p>
          <p className="text-xl font-semibold tabular">{rupees(i.current.deliveredPaise)}</p>
          <p className="text-xs text-muted-foreground">
            on {i.current.marketplace.name} · {i.current.offerCount} current offer
            {i.current.offerCount === 1 ? "" : "s"} · observed {relativeTime(i.current.observedAt)}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No current, in-stock offer.</p>
      )}
      <Movement item={i} />
      {i.note ? <p className="text-xs">{i.note}</p> : null}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link href={`/compare?product=${i.product.id}&variant=${i.variant.id}`}>Offers</Link>
        </Button>
        <PriceAlertDialog
          variantId={i.variant.id}
          currentPricePaise={i.current?.deliveredPaise ?? null}
          sources={[]}
        />
        <span className="ml-auto text-xs text-muted-foreground">
          added {relativeTime(i.addedAt)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${i.product.name}`}
          disabled={removing}
          onClick={onRemove}
        >
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </div>
    </article>
  );
}

/** 7-day movement of the lowest delivered price, from stored observations only. */
function Movement({ item }: { item: Item }) {
  const mv = item.movement;
  if (!mv)
    return (
      <p className="text-xs text-muted-foreground">
        7-day change: no price observed 7 days ago to compare.
      </p>
    );
  if (mv.changePaise === 0)
    return (
      <Badge tone="neutral" className="self-start">
        <Minus aria-hidden className="size-3" /> Unchanged in 7 days
      </Badge>
    );
  const down = mv.changePaise < 0;
  return (
    <Badge tone={down ? "success" : "warning"} className="self-start">
      {down ? (
        <ArrowDownRight aria-hidden className="size-3" />
      ) : (
        <ArrowUpRight aria-hidden className="size-3" />
      )}
      {down ? "Down" : "Up"} {rupees(Math.abs(mv.changePaise))} ({percent(Math.abs(mv.changeBp))})
      in 7 days
    </Badge>
  );
}

function RenameDialog({ id, name }: { id: string; name: string }) {
  const m = useWatchlistMutations();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await m.rename.mutateAsync({ id, name: value.trim() });
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(name);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Pencil aria-hidden className="size-4" /> Rename
        </Button>
      </DialogTrigger>
      <DialogContent title="Rename watchlist">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <label htmlFor="wl-rename" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="wl-rename"
            value={value}
            maxLength={80}
            onChange={(e) => setValue(e.target.value)}
          />
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" disabled={!value.trim() || m.rename.isPending}>
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
