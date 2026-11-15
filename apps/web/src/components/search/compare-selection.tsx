"use client";

/**
 * Products picked for side-by-side comparison from a result list. Each pick is
 * a specific variant, so the comparison can say when two picks are different
 * variants (or different products) rather than presenting them as identical.
 */
import { GitCompareArrows, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

export const MAX_COMPARE = 4;

export interface ComparePick {
  productId: string;
  variantId: string;
  name: string;
  variantLabel: string;
}

interface CompareState {
  picks: ComparePick[];
  has: (variantId: string) => boolean;
  toggle: (pick: ComparePick) => void;
  clear: () => void;
  full: boolean;
}

const Ctx = createContext<CompareState | null>(null);

export function compareHref(picks: Pick<ComparePick, "productId" | "variantId">[]): string {
  return `/compare?items=${picks.map((p) => `${p.productId}:${p.variantId}`).join(",")}`;
}

export function CompareSelectionProvider({ children }: { children: ReactNode }) {
  const [picks, setPicks] = useState<ComparePick[]>([]);
  const has = useCallback(
    (variantId: string) => picks.some((p) => p.variantId === variantId),
    [picks],
  );
  const toggle = useCallback(
    (pick: ComparePick) =>
      setPicks((cur) =>
        cur.some((p) => p.variantId === pick.variantId)
          ? cur.filter((p) => p.variantId !== pick.variantId)
          : cur.length >= MAX_COMPARE
            ? cur
            : [...cur, pick],
      ),
    [],
  );
  const value = useMemo(
    () => ({ picks, has, toggle, clear: () => setPicks([]), full: picks.length >= MAX_COMPARE }),
    [picks, has, toggle],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside a provider: cards then simply don't offer comparison selection. */
export const useCompareSelection = () => useContext(Ctx);

export function CompareToggle({ pick }: { pick: ComparePick }) {
  const sel = useCompareSelection();
  if (!sel) return null;
  const on = sel.has(pick.variantId);
  const disabled = !on && sel.full;
  return (
    <label
      className={`inline-flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-sm ${disabled ? "opacity-60" : "cursor-pointer hover:bg-muted"}`}
      title={disabled ? `You can compare up to ${MAX_COMPARE} products` : undefined}
    >
      <input
        type="checkbox"
        className="size-4 accent-[var(--color-primary)]"
        checked={on}
        disabled={disabled}
        onChange={() => sel.toggle(pick)}
      />
      Compare
    </label>
  );
}

export function CompareTray() {
  const sel = useCompareSelection();
  if (!sel?.picks.length) return null;
  return (
    <aside
      aria-label="Products selected for comparison"
      className="sticky bottom-3 z-30 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-lg"
    >
      <ul className="flex min-w-0 flex-1 flex-wrap gap-2">
        {sel.picks.map((p) => (
          <li
            key={p.variantId}
            className="flex max-w-full items-center gap-1 rounded-full bg-muted py-1 pr-1 pl-3 text-xs"
          >
            <span className="truncate">
              {p.name}
              {p.variantLabel ? ` · ${p.variantLabel}` : ""}
            </span>
            <button
              type="button"
              aria-label={`Remove ${p.name} from comparison`}
              className="rounded-full p-0.5 hover:bg-surface"
              onClick={() => sel.toggle(p)}
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={sel.clear}>
          Clear
        </Button>
        {sel.picks.length >= 2 ? (
          <Button size="sm" asChild>
            <Link href={compareHref(sel.picks)}>
              <GitCompareArrows aria-hidden className="size-4" /> Compare {sel.picks.length}
            </Link>
          </Button>
        ) : (
          <span className="self-center text-xs text-muted-foreground">
            Pick one more to compare
          </span>
        )}
      </div>
    </aside>
  );
}
