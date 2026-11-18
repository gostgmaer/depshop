"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowRight,
  History,
  Mic,
  MicOff,
  Package,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useForm, useWatch } from "react-hook-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCreateSearch, useProductSuggestions, useSearches } from "@/hooks/queries";
import { useDebounced } from "@/hooks/use-debounced";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { errorMessage } from "@/lib/auth-hooks";
import { cn } from "@/lib/utils";
import { SearchFilters, activeFilterCount } from "./search-filters";
import {
  EMPTY_SEARCH,
  EXAMPLE_QUERIES,
  type SearchFormValues,
  searchFormSchema,
  toSearchInput,
} from "./search-input";

export interface Suggestion {
  text: string;
  kind: "recent" | "product" | "example";
}

const KIND_LABEL: Record<Suggestion["kind"], string> = {
  recent: "Recent",
  product: "In catalog",
  example: "Example",
};

/** Recent queries, then catalog products, then examples; filtered by the typed text. */
export function buildSuggestions(
  query: string,
  recent: string[],
  products: string[],
  limit = 7,
): Suggestion[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const add = (text: string, kind: Suggestion["kind"]) => {
    const key = text.toLowerCase();
    if (seen.has(key) || key === q) return;
    seen.add(key);
    out.push({ text, kind });
  };
  for (const r of recent) if (!q || r.toLowerCase().includes(q)) add(r, "recent");
  for (const p of products) add(p, "product");
  for (const e of EXAMPLE_QUERIES) if (!q || e.toLowerCase().includes(q)) add(e, "example");
  return out.slice(0, limit);
}

/**
 * Natural-language search with autocomplete and optional explicit filters
 * (which always win over what the AI infers). The text alone is enough to
 * search: filters are never required.
 */
export function AiSearchBar({
  compact = false,
  initialFilters = false,
  initialValues,
  submitLabel = "Search",
  onSubmitted,
}: {
  compact?: boolean;
  initialFilters?: boolean;
  /** Prefill (editing a previous search). */
  initialValues?: SearchFormValues;
  submitLabel?: string;
  onSubmitted?: (searchId: string) => void;
}) {
  const router = useRouter();
  const create = useCreateSearch();
  // null = "default": open from the sm breakpoint up, closed on phones (CSS, so no flash after
  // hydration). An explicit toggle sets true/false and then applies to every screen size.
  const [showFilters, setShowFilters] = useState<boolean | null>(initialFilters ? null : false);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    setWide(mq.matches);
    const on = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const filtersVisible = showFilters ?? wide;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const submitting = useRef(false);
  const recent = useSearches(1);
  const listId = useId();
  const form = useForm<SearchFormValues>({
    resolver: zodResolver(searchFormSchema),
    defaultValues: initialValues ?? EMPTY_SEARCH,
  });
  const values = useWatch({ control: form.control }) as SearchFormValues;
  const query = values.query ?? "";
  const debounced = useDebounced(query.trim(), 250);
  const products = useProductSuggestions(debounced);

  const setQuery = useCallback(
    (text: string) => form.setValue("query", text, { shouldValidate: true, shouldDirty: true }),
    [form],
  );
  const voice = useVoiceInput(setQuery);

  const suggestions = useMemo(
    () =>
      buildSuggestions(
        query,
        [...new Set((recent.data?.items ?? []).map((s) => s.query))].slice(0, 4),
        debounced.length >= 3 ? (products.data?.items ?? []).map((p) => p.name) : [],
      ),
    [query, debounced, recent.data, products.data],
  );
  const expanded = open && suggestions.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const submit = form.handleSubmit(async (v) => {
    // A double click or Enter held down must not start a second search.
    if (submitting.current) return;
    submitting.current = true;
    try {
      const search = await create.mutateAsync(toSearchInput(v));
      setOpen(false);
      onSubmitted?.(search.id);
      router.push(`/search/${search.id}`);
    } catch (err) {
      form.setError("root", { message: errorMessage(err) });
    } finally {
      submitting.current = false;
    }
  });

  const choose = (s: Suggestion) => {
    setQuery(s.text);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      const n = suggestions.length;
      if (!n) return;
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    } else if (e.key === "Enter" && expanded && active >= 0 && suggestions[active]) {
      e.preventDefault();
      choose(suggestions[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  const filterCount = activeFilterCount(values);
  const busy = form.formState.isSubmitting || create.isPending;
  const queryField = form.register("query", {
    onChange: () => {
      setOpen(true);
      setActive(-1);
    },
  });

  return (
    <form
      onSubmit={(e) => void submit(e)}
      noValidate
      className="flex flex-col gap-3"
      role="search"
      aria-label="AI shopping search"
    >
      <div
        className={cn(
          "relative flex items-center gap-1.5 rounded-2xl border border-border bg-surface p-2 shadow-(--shadow-card) transition-shadow sm:gap-2",
          "focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10",
        )}
      >
        <Sparkles aria-hidden className="ml-2 hidden size-5 shrink-0 text-accent sm:block" />
        <label htmlFor={`${listId}-q`} className="sr-only">
          Describe what you want to buy
        </label>
        <input
          id={`${listId}-q`}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={`${listId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          enterKeyHint="search"
          placeholder="e.g. a smartphone under ₹35,000 with 8GB RAM and 256GB storage"
          className={cn(
            "min-w-0 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground",
            compact ? "h-10 text-sm" : "h-12 text-base",
          )}
          aria-invalid={!!form.formState.errors.query}
          aria-describedby={form.formState.errors.query ? `${listId}-err` : undefined}
          {...queryField}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            void queryField.onBlur(e);
            setTimeout(() => setOpen(false), 120);
          }}
        />
        {voice.supported ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={voice.listening ? "Stop voice input" : "Search by voice"}
            aria-pressed={voice.listening}
            onClick={voice.listening ? voice.stop : voice.start}
          >
            {voice.listening ? (
              <MicOff aria-hidden className="size-4 text-accent" />
            ) : (
              <Mic aria-hidden className="size-4" />
            )}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            filtersVisible
              ? "Hide filters"
              : `Show filters${filterCount ? ` (${filterCount} set)` : ""}`
          }
          aria-pressed={filtersVisible}
          onClick={() => setShowFilters(!filtersVisible)}
        >
          <SlidersHorizontal aria-hidden className="size-4" />
          {filterCount ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-accent text-[10px] font-semibold text-accent-foreground"
            >
              {filterCount}
            </span>
          ) : null}
        </Button>
        <Button
          type="submit"
          variant="ai"
          size={compact ? "default" : "lg"}
          disabled={busy}
          // Icon-only on phones so the input keeps its width; the label stays for screen readers.
          className="max-sm:px-3"
        >
          <span className="sr-only sm:not-sr-only">{busy ? "Starting…" : submitLabel}</span>
          <ArrowRight aria-hidden className="size-4" />
        </Button>
        <ul
          id={`${listId}-list`}
          role="listbox"
          aria-label="Search suggestions"
          hidden={!expanded}
          className="absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-lg"
        >
          {suggestions.map((s, i) => {
            const Icon = s.kind === "recent" ? History : s.kind === "product" ? Package : Sparkles;
            return (
              <li
                key={`${s.kind}:${s.text}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm",
                  i === active ? "bg-muted" : "hover:bg-muted",
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(s)}
              >
                <Icon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0",
                    s.kind === "example" ? "text-accent" : "text-muted-foreground",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{s.text}</span>
                <span className="text-xs text-muted-foreground">{KIND_LABEL[s.kind]}</span>
              </li>
            );
          })}
        </ul>
      </div>
      {voice.listening ? (
        <p role="status" className="text-sm text-accent">
          Listening… say what you want to buy.
        </p>
      ) : null}
      {voice.error ? <p className="text-sm text-muted-foreground">{voice.error}</p> : null}
      {form.formState.errors.query ? (
        <p id={`${listId}-err`} className="text-sm text-danger">
          {form.formState.errors.query.message}
        </p>
      ) : null}
      {form.formState.errors.root ? (
        <Alert tone="error">{form.formState.errors.root.message}</Alert>
      ) : null}
      {showFilters !== false ? (
        <div className={showFilters === null ? "hidden sm:block" : undefined}>
          <SearchFilters form={form} />
        </div>
      ) : null}
    </form>
  );
}
