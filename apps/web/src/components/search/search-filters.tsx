"use client";

/**
 * Advanced search filters. General filters are always available; the
 * category-specific ones (and the brand list) come from
 * GET /categories/:slug/filters — the specifications products in that
 * category actually state — so no category is hard-coded in the UI.
 * Every filter is optional: natural-language search never needs this form.
 */
import { Info, RotateCcw } from "lucide-react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ErrorState, NativeSelect } from "@/components/ui/misc";
import { Checkbox, Label } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { useCategories, useCategoryFilters, useSourceStatus } from "@/hooks/queries";
import { rupees } from "@/lib/format";
import type { CategoryNode } from "@/types/api";
import {
  DISCOUNT_CHOICES,
  EMPTY_SEARCH,
  LAUNCH_CHOICES,
  RANKING_CHOICES,
  SORT_EXPLANATION,
  SORT_LABEL,
  type SearchFormValues,
  parseBrandList,
} from "./search-input";

export function flattenCategories(
  nodes: CategoryNode[],
  depth = 0,
): { slug: string; name: string; depth: number }[] {
  return nodes.flatMap((n) => [
    { slug: n.slug, name: n.name, depth },
    ...flattenCategories(n.children, depth + 1),
  ]);
}

/** Number of filters set (shown on the filter toggle). */
export function activeFilterCount(v: SearchFormValues): number {
  return [
    v.minPrice,
    v.maxPrice,
    v.category,
    v.brands.length > 0,
    v.sortMode,
    v.sourceSlugs.length > 0,
    v.minDiscount,
    v.launchedWithin,
    v.inStockOnly,
    ...Object.values(v.specs),
  ].filter(Boolean).length;
}

type Form = UseFormReturn<SearchFormValues>;

export function SearchFilters({ form }: { form: Form }) {
  const values = useWatch({ control: form.control }) as SearchFormValues;
  const slug = values.subcategory || values.category || undefined;
  const facets = useCategoryFilters(slug);
  const e = form.formState.errors;
  const dirty = { shouldDirty: true, shouldValidate: true } as const;
  const specError = (e.specs as { message?: string } | undefined)?.message;

  return (
    <fieldset
      className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-4"
      aria-describedby="filters-note"
    >
      <legend className="sr-only">Search filters</legend>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p id="filters-note" className="max-w-2xl text-xs text-muted-foreground">
          Optional. Filters you set here are hard requirements and win over what the AI reads from
          your words. Offers that don&apos;t state a required detail are left out, never assumed.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => form.reset({ ...EMPTY_SEARCH, query: form.getValues("query") })}
        >
          <RotateCcw aria-hidden className="size-4" /> Clear filters
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <CategoryFields form={form} values={values} subcategories={facets.data?.subcategories} />
        <Field
          label="Min price (₹)"
          error={e.minPrice?.message}
          {...(facets.data?.priceRange
            ? {
                hint: `Current offers here: ${rupees(facets.data.priceRange.minPaise)} – ${rupees(facets.data.priceRange.maxPaise)}`,
              }
            : {})}
        >
          {(p) => (
            <Input {...p} inputMode="decimal" placeholder="Any" {...form.register("minPrice")} />
          )}
        </Field>
        <Field label="Max price (₹)" error={e.maxPrice?.message}>
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              placeholder="e.g. 35,000"
              {...form.register("maxPrice")}
            />
          )}
        </Field>
        <Field label="Minimum verified discount">
          {(p) => (
            <NativeSelect {...p} {...form.register("minDiscount")}>
              <option value="">Any</option>
              {DISCOUNT_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d}% or more off MRP
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="Launch date"
          {...(facets.data && !facets.data.hasLaunchDates
            ? { hint: "No launch dates are recorded for this category yet." }
            : { hint: "Products with an unknown launch date are left out." })}
        >
          {(p) => (
            <NativeSelect
              {...p}
              {...form.register("launchedWithin")}
              disabled={Boolean(facets.data && !facets.data.hasLaunchDates)}
            >
              <option value="">Any time</option>
              {LAUNCH_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Availability</span>
          <div className="flex items-center gap-2">
            <Checkbox
              id="f-instock"
              checked={values.inStockOnly}
              onCheckedChange={(c) => form.setValue("inStockOnly", c === true, dirty)}
            />
            <Label htmlFor="f-instock" className="font-normal">
              Confirmed in stock only
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Out-of-stock offers are never ranked. This also leaves out pre-orders and unknown
            availability.
          </p>
        </div>
        <RankingField form={form} mode={values.sortMode} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BrandField form={form} brands={values.brands} facetBrands={facets.data?.brands} />
        <SourceField
          selected={values.sourceSlugs}
          onChange={(next) => form.setValue("sourceSlugs", next, dirty)}
        />
      </div>

      <section aria-labelledby="spec-filters-title" className="flex flex-col gap-3">
        <h3 id="spec-filters-title" className="text-sm font-semibold">
          Specifications
        </h3>
        {!slug ? (
          <p className="text-xs text-muted-foreground">
            Choose a category to filter by the specifications its products state (for example RAM
            for phones, capacity for washing machines). You can also just describe them in your
            search.
          </p>
        ) : facets.isPending ? (
          <div role="status" className="grid gap-3 sm:grid-cols-3">
            <span className="sr-only">Loading filters for this category…</span>
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : facets.isError ? (
          <ErrorState
            message="Couldn't load this category's filters."
            onRetry={() => void facets.refetch()}
          />
        ) : facets.data.specs.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {facets.data.specs.map((spec) => (
              <Field
                key={spec.key}
                label={spec.label}
                hint={`Stated by ${spec.productCount} product${spec.productCount === 1 ? "" : "s"}`}
              >
                {(p) => (
                  <NativeSelect
                    {...p}
                    value={values.specs[spec.key] ?? ""}
                    onChange={(ev) => {
                      const next = { ...values.specs };
                      if (ev.target.value) next[spec.key] = ev.target.value;
                      else delete next[spec.key];
                      form.setValue("specs", next, dirty);
                    }}
                  >
                    <option value="">Any</option>
                    {spec.values.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.label} ({v.count})
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No specification data is stored for this category yet, so there are no specification
            filters to offer. Describe what you need in the search instead.
          </p>
        )}
        {specError ? <p className="text-sm text-danger">{specError}</p> : null}
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          There is no rating filter: DealMind has no verified rating data yet.
        </p>
      </section>
    </fieldset>
  );
}

function CategoryFields({
  form,
  values,
  subcategories,
}: {
  form: Form;
  values: SearchFormValues;
  subcategories: { slug: string; name: string; productCount: number }[] | undefined;
}) {
  const categories = useCategories();
  const choose = (field: "category" | "subcategory", slug: string) => {
    form.setValue(field, slug, { shouldDirty: true });
    if (field === "category") form.setValue("subcategory", "", { shouldDirty: true });
    // Specification filters belong to the previous category.
    form.setValue("specs", {}, { shouldDirty: true });
  };
  return (
    <>
      <Field label="Category">
        {(p) => (
          <NativeSelect
            {...p}
            value={values.category}
            onChange={(ev) => choose("category", ev.target.value)}
          >
            <option value="">Any category</option>
            {flattenCategories(categories.data ?? []).map((c) => (
              <option key={c.slug} value={c.slug}>
                {"  ".repeat(c.depth)}
                {c.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {values.category && subcategories?.length ? (
        <Field label="Subcategory">
          {(p) => (
            <NativeSelect
              {...p}
              value={values.subcategory}
              onChange={(ev) => choose("subcategory", ev.target.value)}
            >
              <option value="">All subcategories</option>
              {subcategories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name} ({c.productCount})
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
    </>
  );
}

function RankingField({ form, mode }: { form: Form; mode: SearchFormValues["sortMode"] }) {
  return (
    <div className="flex flex-col gap-1.5 sm:col-span-2">
      <Field label="Ranking">
        {(p) => (
          <NativeSelect {...p} {...form.register("sortMode")}>
            <option value="">Let the AI choose from your words</option>
            {RANKING_CHOICES.map((m) => (
              <option key={m} value={m}>
                {SORT_LABEL[m]}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {mode
          ? SORT_EXPLANATION[mode]
          : "The AI picks a mode from your request (best value if it isn't clear)."}{" "}
        Affiliate commission never affects ranking.
      </p>
    </div>
  );
}

function BrandField({
  form,
  brands,
  facetBrands,
}: {
  form: Form;
  brands: string[];
  facetBrands: { name: string; count: number }[] | undefined;
}) {
  const setBrands = (next: string[]) => form.setValue("brands", next, { shouldDirty: true });
  if (facetBrands?.length) {
    const shown = facetBrands.slice(0, 12);
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Brands</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {shown.map((b) => {
            const id = `brand-${b.name.replace(/[^a-z0-9]+/gi, "-")}`;
            const on = brands.some((x) => x.toLowerCase() === b.name.toLowerCase());
            return (
              <div key={b.name} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={on}
                  onCheckedChange={(c) =>
                    setBrands(
                      c
                        ? [...brands, b.name]
                        : brands.filter((x) => x.toLowerCase() !== b.name.toLowerCase()),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal">
                  {b.name} <span className="text-muted-foreground">({b.count})</span>
                </Label>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">None selected = any brand.</p>
      </fieldset>
    );
  }
  return (
    <Field label="Brands" hint="Comma-separated, e.g. Samsung, OnePlus">
      {(p) => (
        <Input
          {...p}
          placeholder="Any brand"
          key={brands.join("|")}
          defaultValue={brands.join(", ")}
          onBlur={(ev) => setBrands(parseBrandList(ev.target.value))}
        />
      )}
    </Field>
  );
}

const SEARCHABLE = new Set(["ACTIVE", "DEGRADED"]);

function SourceField({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const sources = useSourceStatus();
  const all = sources.data?.sources ?? [];
  const available = all.filter((s) => SEARCHABLE.has(s.connectorStatus));
  const unavailable = all.filter((s) => !SEARCHABLE.has(s.connectorStatus));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Marketplaces</legend>
      {sources.isPending ? (
        <Skeleton className="h-10" />
      ) : available.length ? (
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {available.map((s) => (
            <div key={s.slug} className="flex items-center gap-2">
              <Checkbox
                id={`src-${s.slug}`}
                checked={selected.includes(s.slug)}
                onCheckedChange={(c) =>
                  onChange(c ? [...selected, s.slug] : selected.filter((x) => x !== s.slug))
                }
              />
              <Label htmlFor={`src-${s.slug}`} className="font-normal">
                {s.name}
                {s.isSample ? <span className="text-muted-foreground"> (mock)</span> : null}
              </Label>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No marketplace is searchable right now.</p>
      )}
      <p className="text-xs text-muted-foreground">
        None selected = every searchable marketplace.
        {unavailable.length
          ? ` Not searchable yet: ${unavailable.map((s) => s.name).join(", ")}.`
          : ""}
      </p>
    </fieldset>
  );
}
