"use client";

import {
  AlertTriangle,
  Clock,
  HelpCircle,
  Pencil,
  RefreshCw,
  SearchX,
  Sparkles,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { SEARCH_STATUS, isRunning } from "@/components/dashboard/widgets";
import { AiSearchBar } from "@/components/search/ai-search-bar";
import { CompareSelectionProvider, CompareTray } from "@/components/search/compare-selection";
import { ResultCard, type ResultLayout } from "@/components/search/result-card";
import { SearchProgressPanel } from "@/components/search/search-progress";
import { SORT_LABEL, fromSearch, toSearchInput } from "@/components/search/search-input";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  ErrorState,
  NativeSelect,
  PageHeader,
  Pagination,
  SegmentedControl,
} from "@/components/ui/misc";
import { LoadingRows, Skeleton } from "@/components/ui/skeleton";
import { useCancelSearch, useCreateSearch, useSearch, useSearchResults } from "@/hooks/queries";
import { useSearchEvents } from "@/hooks/use-search-events";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDateTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SearchDetail, SearchResultSort } from "@/types/api";

/** What each status means for the user (shown under the badge). */
export const STATUS_HELP: Record<string, string> = {
  PENDING: "Accepted. Waiting for a search worker to start it.",
  RUNNING: "Searching marketplaces now. Results appear as they are ranked.",
  COMPLETED: "Every marketplace that was searched responded.",
  PARTIAL: "Some marketplaces failed or timed out. These results come only from the others.",
  FAILED: "The search couldn't produce results.",
  NEEDS_CLARIFICATION: "The AI needs one more detail before searching.",
  CANCELLED: "You cancelled this search. Results found before cancelling are kept.",
};

const RESULT_SORTS: { value: SearchResultSort; label: string }[] = [
  { value: "rank", label: "Ranked order" },
  { value: "price_asc", label: "Lowest delivered price" },
  { value: "discount_desc", label: "Highest verified discount" },
  { value: "newest", label: "Newest launch" },
];
const isSort = (v: string | null): v is SearchResultSort => RESULT_SORTS.some((s) => s.value === v);

function useUrlState() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const sortParam = params.get("sort");
  const sort: SearchResultSort = isSort(sortParam) ? sortParam : "rank";
  const view: ResultLayout = params.get("view") === "grid" ? "grid" : "list";
  const update = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  return { page, sort, view, update };
}

export function SearchView({ id }: { id: string }) {
  const search = useSearch(id);
  const running = isRunning(search.data?.status);
  const live = useSearchEvents(id, search.data !== undefined);
  const url = useUrlState();
  const results = useSearchResults(id, search.data?.status, url.page, url.sort);
  const cancel = useCancelSearch(id);
  const rerun = useCreateSearch();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  if (search.isPending)
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading search…</span>
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-28" />
        <LoadingRows rows={3} />
      </div>
    );
  if (search.isError)
    return search.error instanceof ApiError && search.error.status === 404 ? (
      <EmptyState
        icon={HelpCircle}
        title="Search not found"
        description="It may have been removed, or it belongs to another account."
      />
    ) : (
      <ErrorState message={errorMessage(search.error)} onRetry={() => void search.refetch()} />
    );

  const s = search.data;
  const st = SEARCH_STATUS[s.status] ?? { label: s.status, tone: "neutral" as const };
  const items = results.data?.items ?? [];
  const total = results.data?.pagination.total ?? 0;
  const staleCount = items.filter((r) => r.offer.isStale).length;
  const runAgain = async () => {
    setRerunError(null);
    try {
      const next = await rerun.mutateAsync(toSearchInput(fromSearch(s.query, s.filters)));
      router.push(`/search/${next.id}`);
    } catch (err) {
      setRerunError(errorMessage(err));
    }
  };

  return (
    <CompareSelectionProvider>
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            <span className="text-xs text-muted-foreground">
              Started {relativeTime(s.createdAt)}
              {s.completedAt ? ` · finished ${formatDateTime(s.completedAt)}` : ""}
            </span>
          </span>
        }
        title={s.query}
        description={STATUS_HELP[s.status]}
        actions={
          <>
            {running ? (
              <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <X aria-hidden className="size-4" />{" "}
                {cancel.isPending ? "Cancelling…" : "Cancel search"}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void runAgain()} disabled={rerun.isPending}>
                <RefreshCw aria-hidden className="size-4" />{" "}
                {rerun.isPending ? "Starting…" : "Run again"}
              </Button>
            )}
            <Button variant="ghost" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
              <Pencil aria-hidden className="size-4" /> {editing ? "Close editor" : "Edit search"}
            </Button>
          </>
        }
      />
      {cancel.isError ? <Alert tone="error">{errorMessage(cancel.error)}</Alert> : null}
      {rerunError ? <Alert tone="error">{rerunError}</Alert> : null}
      {editing ? (
        <section aria-label="Edit search" className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Change the words or filters and search again. This starts a new search; this one stays
            in your history.
          </p>
          <AiSearchBar
            compact
            initialFilters={Object.keys(s.filters).length > 0}
            initialValues={fromSearch(s.query, s.filters)}
            submitLabel="Search again"
          />
        </section>
      ) : null}

      <SearchProgressPanel detail={s} live={live} running={running} />

      <Interpretation detail={s} />

      {s.clarificationQuestion ? (
        <section className="flex flex-col gap-3 rounded-xl border border-accent/25 bg-accent-soft p-4">
          <p className="flex items-start gap-2 text-sm font-medium">
            <HelpCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
            {s.clarificationQuestion}
          </p>
          <p className="text-xs text-muted-foreground">Add the missing detail and search again:</p>
          <AiSearchBar compact initialValues={fromSearch(s.query, s.filters)} />
        </section>
      ) : null}

      {s.agentRun?.status === "FAILED" ? (
        <Alert tone="error">
          The AI agent stopped with an error before finishing. Results already ranked are shown
          below; you can run the search again.
        </Alert>
      ) : null}

      {s.summary ? (
        <section
          aria-label="AI summary"
          className="flex gap-3 rounded-xl border border-accent/20 bg-surface p-4"
        >
          <Sparkles aria-hidden className="mt-0.5 size-5 shrink-0 text-accent" />
          <div className="text-sm">
            <p>{s.summary}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Written from the verified results below; it never adds prices or offers.
            </p>
          </div>
        </section>
      ) : null}

      {s.warnings.length ? (
        <ul className="flex flex-col gap-1.5" aria-label="Warnings">
          {s.warnings.map((w) => (
            <li
              key={w}
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
            >
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      ) : null}

      <section aria-labelledby="results-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="results-title" className="text-lg font-semibold">
              {running ? "Results so far" : s.status === "PARTIAL" ? "Partial results" : "Results"}
            </h2>
            {results.data ? (
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {total} ranked deal{total === 1 ? "" : "s"}
                {running ? " · more may arrive" : ""}
              </p>
            ) : null}
          </div>
          {total > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="result-sort" className="text-sm text-muted-foreground">
                Sort
              </label>
              <NativeSelect
                id="result-sort"
                className="h-10 w-56"
                value={url.sort}
                onChange={(e) =>
                  url.update({
                    sort: e.target.value === "rank" ? null : e.target.value,
                    page: null,
                  })
                }
              >
                {RESULT_SORTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
              <SegmentedControl
                label="Result layout"
                value={url.view}
                options={[
                  { value: "list", label: "List" },
                  { value: "grid", label: "Grid" },
                ]}
                onChange={(v) => url.update({ view: v === "list" ? null : v })}
              />
            </div>
          ) : null}
        </div>

        {s.status === "PARTIAL" && items.length ? (
          <Alert tone="warning">
            Partial results: some marketplaces failed or timed out (see above), so cheaper offers
            there may be missing.
          </Alert>
        ) : null}
        {url.sort !== "rank" && items.length ? (
          <p className="text-xs text-muted-foreground">
            Re-ordered by {RESULT_SORTS.find((o) => o.value === url.sort)?.label.toLowerCase()}. The
            rank numbers are still those of the{" "}
            {s.ranking
              ? (SORT_LABEL[s.ranking.mode as keyof typeof SORT_LABEL] ?? s.ranking.mode)
              : ""}{" "}
            ranking.
          </p>
        ) : null}
        {staleCount && !running ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
            <span className="flex items-start gap-2">
              <Clock aria-hidden className="mt-0.5 size-4 shrink-0" />
              {staleCount === items.length
                ? "These results have expired"
                : `${staleCount} result${staleCount === 1 ? " has" : "s have"} expired`}
              : their prices weren&apos;t observed in the last 24 hours and may have changed.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runAgain()}
              disabled={rerun.isPending}
            >
              Get fresh prices
            </Button>
          </div>
        ) : null}

        {results.isError ? (
          <ErrorState
            message={errorMessage(results.error)}
            onRetry={() => void results.refetch()}
          />
        ) : items.length ? (
          <>
            <ol
              className={cn(
                url.view === "grid"
                  ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                  : "flex flex-col gap-3",
                results.isPlaceholderData && "opacity-60 transition-opacity",
              )}
              aria-busy={results.isFetching}
            >
              {items.map((r) => (
                <li key={r.offer.id}>
                  <ResultCard result={r} layout={url.view} />
                </li>
              ))}
            </ol>
            {results.data ? (
              <Pagination
                meta={results.data.pagination}
                onPage={(p) => url.update({ page: p === 1 ? null : String(p) })}
              />
            ) : null}
          </>
        ) : running || s.status === "PENDING" ? (
          <LoadingRows rows={2} label="Waiting for results" />
        ) : (
          <NoResults
            detail={s}
            onRunAgain={() => void runAgain()}
            onEdit={() => setEditing(true)}
          />
        )}
      </section>
      <CompareTray />
    </CompareSelectionProvider>
  );
}

/** How the search was read: the filters actually applied and the ranking used. */
function Interpretation({ detail }: { detail: SearchDetail }) {
  if (!detail.ranking) return null;
  const mode = detail.ranking.mode as keyof typeof SORT_LABEL;
  return (
    <p className="text-xs text-muted-foreground">
      Ranked by <span className="font-medium text-foreground">{SORT_LABEL[mode] ?? mode}</span> (
      {detail.ranking.chosenBy === "user" ? "your choice" : "chosen by the AI from your words"}).
      Affiliate commission never affects ranking.
    </p>
  );
}

function NoResults({
  detail,
  onRunAgain,
  onEdit,
}: {
  detail: SearchDetail;
  onRunAgain: () => void;
  onEdit: () => void;
}) {
  const searched = detail.sourceRuns.filter((r) => r.status !== "SKIPPED");
  const succeeded = searched.filter((r) => r.status === "SUCCEEDED");
  const listings = succeeded.reduce((n, r) => n + r.resultCount, 0);
  if (detail.clarificationQuestion) return null;
  const actions = (
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" onClick={onEdit}>
        <Pencil aria-hidden className="size-4" /> Edit search
      </Button>
      <Button size="sm" variant="outline" onClick={onRunAgain}>
        <RefreshCw aria-hidden className="size-4" /> Run again
      </Button>
    </div>
  );
  if (detail.status === "CANCELLED")
    return (
      <EmptyState
        icon={X}
        title="Search cancelled"
        description="It was stopped before any deal was ranked."
        action={actions}
      />
    );
  if (detail.status === "FAILED")
    return (
      <EmptyState
        icon={AlertTriangle}
        title="The search failed"
        description={
          searched.length === 0
            ? "No marketplace could be searched (see the marketplace list above). Try again in a moment."
            : succeeded.length === 0
              ? "Every marketplace searched failed or timed out. Try again in a moment."
              : "The AI agent stopped with an error. Try again in a moment."
        }
        action={actions}
      />
    );
  return (
    <EmptyState
      icon={SearchX}
      title={listings === 0 ? "No marketplace returned listings" : "No matching products"}
      description={
        listings === 0
          ? "The marketplaces searched had no listings for this request. Try broader words or another category."
          : `${listings} listing${listings === 1 ? "" : "s"} came back, but none met every requirement (budget, specifications, availability, discount or launch date). Try a wider budget or fewer filters.`
      }
      action={actions}
    />
  );
}
