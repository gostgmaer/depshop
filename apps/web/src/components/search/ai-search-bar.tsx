"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, History, SlidersHorizontal, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/misc";
import { Checkbox, Label } from "@/components/ui/primitives";
import { useCategories, useCreateSearch, useSearches, useSourceStatus } from "@/hooks/queries";
import { errorMessage } from "@/lib/auth-hooks";
import { cn } from "@/lib/utils";
import type { CategoryNode } from "@/types/api";
import {
  EMPTY_SEARCH,
  EXAMPLE_QUERIES,
  SORT_LABEL,
  type SearchFormValues,
  searchFormSchema,
  toSearchInput,
} from "./search-input";

function flatten(
  nodes: CategoryNode[],
  depth = 0,
): { slug: string; name: string; depth: number }[] {
  return nodes.flatMap((n) => [
    { slug: n.slug, name: n.name, depth },
    ...flatten(n.children, depth + 1),
  ]);
}

/**
 * Natural-language search with optional explicit filters. Explicit filters
 * always win over what the AI infers from the text.
 */
export function AiSearchBar({
  compact = false,
  initialFilters = false,
}: {
  compact?: boolean;
  initialFilters?: boolean;
}) {
  const router = useRouter();
  const create = useCreateSearch();
  const [showFilters, setShowFilters] = useState(initialFilters);
  const [focused, setFocused] = useState(false);
  const recent = useSearches(1);
  const listId = useId();
  const form = useForm<SearchFormValues>({
    resolver: zodResolver(searchFormSchema),
    defaultValues: EMPTY_SEARCH,
  });
  const query = form.watch("query");

  const submit = form.handleSubmit(async (values) => {
    try {
      const search = await create.mutateAsync(toSearchInput(values));
      router.push(`/search/${search.id}`);
    } catch (err) {
      form.setError("root", { message: errorMessage(err) });
    }
  });

  const recentQueries = [...new Set((recent.data?.items ?? []).map((s) => s.query))].slice(0, 4);
  const suggestions = [
    ...recentQueries.map((q) => ({ q, recent: true })),
    ...EXAMPLE_QUERIES.filter((q) => !recentQueries.includes(q)).map((q) => ({ q, recent: false })),
  ].filter((s) => !query || s.q.toLowerCase().includes(query.toLowerCase()));

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
          "relative flex items-center gap-2 rounded-2xl border border-border bg-surface p-2 shadow-[var(--shadow-card)] transition-shadow",
          "focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10",
        )}
      >
        <Sparkles aria-hidden className="ml-2 size-5 shrink-0 text-accent" />
        <label htmlFor={`${listId}-q`} className="sr-only">
          Describe what you want to buy
        </label>
        <input
          id={`${listId}-q`}
          autoComplete="off"
          placeholder="e.g. a smartphone under ₹35,000 with 8GB RAM and 256GB storage"
          className={cn(
            "min-w-0 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground",
            compact ? "h-10 text-sm" : "h-12 text-base",
          )}
          aria-invalid={!!form.formState.errors.query}
          aria-describedby={form.formState.errors.query ? `${listId}-err` : undefined}
          aria-controls={focused && suggestions.length > 0 ? `${listId}-suggestions` : undefined}
          {...form.register("query")}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={showFilters ? "Hide filters" : "Show filters"}
          aria-pressed={showFilters}
          onClick={() => setShowFilters((s) => !s)}
        >
          <SlidersHorizontal aria-hidden className="size-4" />
        </Button>
        <Button
          type="submit"
          variant="ai"
          size={compact ? "default" : "lg"}
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting ? "Starting…" : "Search"}
          <ArrowRight aria-hidden className="size-4" />
        </Button>
        <AnimatePresence>
          {focused && suggestions.length > 0 ? (
            <motion.ul
              id={`${listId}-suggestions`}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              aria-label="Search suggestions"
              className="absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-lg"
            >
              {suggestions.slice(0, 6).map((s) => (
                <li key={s.q}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      form.setValue("query", s.q, { shouldValidate: true });
                      setFocused(false);
                    }}
                  >
                    {s.recent ? (
                      <History aria-hidden className="size-4 text-muted-foreground" />
                    ) : (
                      <Sparkles aria-hidden className="size-4 text-accent" />
                    )}
                    <span className="truncate">{s.q}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {s.recent ? "Recent" : "Example"}
                    </span>
                  </button>
                </li>
              ))}
            </motion.ul>
          ) : null}
        </AnimatePresence>
      </div>
      {form.formState.errors.query ? (
        <p id={`${listId}-err`} className="text-sm text-danger">
          {form.formState.errors.query.message}
        </p>
      ) : null}
      {form.formState.errors.root ? (
        <Alert tone="error">{form.formState.errors.root.message}</Alert>
      ) : null}
      {showFilters ? <SearchFilters form={form} /> : null}
    </form>
  );
}

function SearchFilters({ form }: { form: ReturnType<typeof useForm<SearchFormValues>> }) {
  const categories = useCategories();
  const sources = useSourceStatus();
  const available = (sources.data?.sources ?? []).filter(
    (s) => s.connectorStatus === "ACTIVE" || s.connectorStatus === "DEGRADED",
  );
  const selected = form.watch("sourceSlugs");
  const e = form.formState.errors;
  return (
    <fieldset className="grid gap-4 rounded-xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
      <legend className="sr-only">Search filters</legend>
      <Field label="Min budget (₹)" error={e.minPrice?.message}>
        {(p) => (
          <Input {...p} inputMode="decimal" placeholder="Any" {...form.register("minPrice")} />
        )}
      </Field>
      <Field label="Max budget (₹)" error={e.maxPrice?.message}>
        {(p) => (
          <Input
            {...p}
            inputMode="decimal"
            placeholder="e.g. 35,000"
            {...form.register("maxPrice")}
          />
        )}
      </Field>
      <Field label="Category">
        {(p) => (
          <NativeSelect {...p} {...form.register("category")}>
            <option value="">Any category</option>
            {flatten(categories.data ?? []).map((c) => (
              <option key={c.slug} value={c.slug}>
                {"  ".repeat(c.depth)}
                {c.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="Ranking">
        {(p) => (
          <NativeSelect {...p} {...form.register("sortMode")}>
            <option value="">Let the AI decide</option>
            {Object.entries(SORT_LABEL).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="Brands" hint="Comma-separated, e.g. Samsung, OnePlus">
        {(p) => <Input {...p} placeholder="Any brand" {...form.register("brands")} />}
      </Field>
      <Field label="RAM">
        {(p) => (
          <NativeSelect {...p} {...form.register("ram")}>
            <option value="">Any</option>
            {["4GB", "6GB", "8GB", "12GB", "16GB", "32GB"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="Storage">
        {(p) => (
          <NativeSelect {...p} {...form.register("storage")}>
            <option value="">Any</option>
            {["64GB", "128GB", "256GB", "512GB", "1TB"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Marketplaces</span>
        {available.length ? (
          available.map((s) => (
            <div key={s.slug} className="flex items-center gap-2">
              <Checkbox
                id={`src-${s.slug}`}
                checked={selected.includes(s.slug)}
                onCheckedChange={(c) =>
                  form.setValue(
                    "sourceSlugs",
                    c ? [...selected, s.slug] : selected.filter((x) => x !== s.slug),
                  )
                }
              />
              <Label htmlFor={`src-${s.slug}`} className="font-normal">
                {s.name}
              </Label>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">No marketplace is searchable right now.</p>
        )}
        <p className="text-xs text-muted-foreground">
          None selected = every available marketplace.
        </p>
      </div>
    </fieldset>
  );
}
