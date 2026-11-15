"use client";

import { AlertTriangle, HelpCircle, Sparkles, X } from "lucide-react";
import { isRunning, SEARCH_STATUS } from "@/components/dashboard/widgets";
import { ResultCard } from "@/components/search/result-card";
import { SearchProgressPanel } from "@/components/search/search-progress";
import { AiSearchBar } from "@/components/search/ai-search-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui/misc";
import { LoadingRows, Skeleton } from "@/components/ui/skeleton";
import { useCancelSearch, useSearch, useSearchResults } from "@/hooks/queries";
import { useSearchEvents } from "@/hooks/use-search-events";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/auth-hooks";
import { relativeTime } from "@/lib/format";

export function SearchView({ id }: { id: string }) {
  const search = useSearch(id);
  const running = isRunning(search.data?.status);
  const live = useSearchEvents(id, running);
  const results = useSearchResults(id, search.data?.status);
  const cancel = useCancelSearch(id);

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
  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            <span className="text-xs text-muted-foreground">
              Started {relativeTime(s.createdAt)}
            </span>
          </span>
        }
        title={s.query}
        actions={
          running ? (
            <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              <X aria-hidden className="size-4" />{" "}
              {cancel.isPending ? "Cancelling…" : "Cancel search"}
            </Button>
          ) : null
        }
      />

      <SearchProgressPanel detail={s} live={live} running={running} />

      {s.clarificationQuestion ? (
        <section className="flex flex-col gap-3 rounded-xl border border-accent/25 bg-accent-soft p-4">
          <p className="flex items-start gap-2 text-sm font-medium">
            <HelpCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
            {s.clarificationQuestion}
          </p>
          <p className="text-xs text-muted-foreground">Add the missing detail and search again:</p>
          <AiSearchBar compact />
        </section>
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
        <ul className="flex flex-col gap-1.5">
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
        <div className="flex items-baseline justify-between">
          <h2 id="results-title" className="text-lg font-semibold">
            {running ? "Results so far" : "Results"}
          </h2>
          {results.data ? (
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {results.data.pagination.total} ranked deal
              {results.data.pagination.total === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {results.isError ? (
          <ErrorState message="Couldn't load results." onRetry={() => void results.refetch()} />
        ) : items.length ? (
          <ol className="flex flex-col gap-3">
            {items.map((r, i) => (
              <li key={r.offer.id}>
                <ResultCard result={r} index={i} />
              </li>
            ))}
          </ol>
        ) : running ? (
          <LoadingRows rows={2} label="Waiting for results" />
        ) : s.status === "FAILED" ? (
          <EmptyState
            icon={AlertTriangle}
            title="The search failed"
            description="No marketplace could be searched successfully. Try again in a moment."
          />
        ) : s.status === "CANCELLED" ? (
          <EmptyState icon={X} title="Search cancelled" />
        ) : s.clarificationQuestion ? null : (
          <EmptyState
            icon={HelpCircle}
            title="No matching offers"
            description="Nothing matched every requirement from the marketplaces searched. Try a wider budget or fewer filters."
          />
        )}
      </section>
    </>
  );
}
