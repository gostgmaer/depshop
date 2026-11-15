"use client";

import { CheckCircle2, CircleDashed, CircleSlash, Clock4, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  STAGE_LABEL,
  type SearchProgress as Progress,
  type SourceProgress,
} from "@/hooks/use-search-events";
import { cn } from "@/lib/utils";
import type { SearchDetail } from "@/types/api";

const SOURCE_STATUS: Record<
  SourceProgress,
  { label: string; icon: typeof CheckCircle2; tone: string }
> = {
  PENDING: { label: "Searching", icon: Loader2, tone: "text-accent" },
  SUCCEEDED: { label: "Done", icon: CheckCircle2, tone: "text-primary" },
  FAILED: { label: "Failed", icon: XCircle, tone: "text-danger" },
  TIMED_OUT: { label: "Timed out", icon: Clock4, tone: "text-warning" },
  SKIPPED: { label: "Not searched", icon: CircleSlash, tone: "text-muted-foreground" },
};

const SKIP_REASON: Record<string, string> = {
  SOURCE_NOT_ACTIVE: "not connected yet",
  NOT_REQUESTED: "not selected",
  EXCLUDED_BY_USER: "excluded",
  CATEGORY_NOT_SUPPORTED: "doesn't cover this category",
  CIRCUIT_OPEN: "temporarily unavailable",
};

export interface SourceRow {
  slug: string;
  name: string;
  status: SourceProgress;
  resultCount: number;
  detail?: string | null;
}

/** Live (SSE) statuses while running; persisted source runs once finished. */
export function mergeSources(detail: SearchDetail | undefined, live: Progress): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  for (const [slug, s] of Object.entries(live.sources)) {
    rows.set(slug, { slug, name: slug, status: s.status, resultCount: s.resultCount });
  }
  for (const r of detail?.sourceRuns ?? []) {
    rows.set(r.source.slug, {
      slug: r.source.slug,
      name: r.source.name,
      status: r.status,
      resultCount: r.resultCount,
      detail:
        r.status === "SKIPPED"
          ? (SKIP_REASON[r.errorCode ?? ""] ?? r.errorMessage)
          : r.errorMessage,
    });
  }
  const order: Record<SourceProgress, number> = {
    SUCCEEDED: 0,
    PENDING: 1,
    TIMED_OUT: 2,
    FAILED: 3,
    SKIPPED: 4,
  };
  return [...rows.values()].sort(
    (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name),
  );
}

export function SearchProgressPanel({
  detail,
  live,
  running,
}: {
  detail: SearchDetail | undefined;
  live: Progress;
  running: boolean;
}) {
  const sources = mergeSources(detail, live);
  const stage = live.stage ? (STAGE_LABEL[live.stage] ?? live.stage) : running ? "Starting…" : null;
  return (
    <section
      aria-labelledby="progress-title"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="progress-title" className="text-sm font-semibold">
          Marketplaces
        </h2>
        {running ? (
          <span
            role="status"
            aria-live="polite"
            className="flex items-center gap-1.5 text-xs text-accent"
          >
            <Loader2 aria-hidden className="size-3.5 animate-spin" /> {stage}
          </span>
        ) : null}
      </div>
      {sources.length ? (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Marketplace status">
          {sources.map((s) => {
            const st = SOURCE_STATUS[s.status];
            const Icon = st.icon;
            return (
              <li
                key={s.slug}
                className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <Icon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0",
                    st.tone,
                    s.status === "PENDING" && "animate-spin",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {st.label}
                    {s.status === "SUCCEEDED"
                      ? ` · ${s.resultCount} result${s.resultCount === 1 ? "" : "s"}`
                      : ""}
                    {s.detail ? ` · ${s.detail}` : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleDashed aria-hidden className="size-4" />
          {running ? "Choosing marketplaces…" : "No marketplace was searched."}
        </p>
      )}
      {sources.some((s) => s.status === "FAILED" || s.status === "TIMED_OUT") ? (
        <Badge tone="warning" className="self-start">
          Some marketplaces failed — results from the others are still shown
        </Badge>
      ) : null}
    </section>
  );
}
