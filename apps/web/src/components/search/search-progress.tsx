"use client";

/**
 * Marketplace status for one search. Every known marketplace is listed:
 * searched ones with their real outcome (live SSE events while running,
 * persisted source runs once finished), the others with the reason they were
 * not searched (pending approval, credentials unavailable, disabled…), taken
 * from the persisted skip reason or the backend's connector status.
 * Nothing is inferred: a marketplace is "Completed" only when it reported so.
 */
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock4,
  KeyRound,
  Loader2,
  type LucideIcon,
  PauseCircle,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSourceStatus } from "@/hooks/queries";
import type { SearchProgress as Progress } from "@/hooks/use-search-events";
import { cn } from "@/lib/utils";
import type { SearchDetail, SourceStatus } from "@/types/api";
import { SearchTimeline } from "./search-timeline";

export type MarketplaceState =
  | "SEARCHING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "PENDING_APPROVAL"
  | "CREDENTIALS_UNAVAILABLE"
  | "DISABLED"
  | "NOT_SELECTED"
  | "NOT_SEARCHED";

const STATE: Record<MarketplaceState, { label: string; icon: LucideIcon; tone: string }> = {
  SEARCHING: { label: "Searching", icon: Loader2, tone: "text-accent" },
  WAITING: {
    label: "Waiting for the search plan",
    icon: CircleDashed,
    tone: "text-muted-foreground",
  },
  COMPLETED: { label: "Completed", icon: CheckCircle2, tone: "text-primary" },
  FAILED: { label: "Failed", icon: XCircle, tone: "text-danger" },
  TIMED_OUT: { label: "Timed out", icon: Clock4, tone: "text-warning" },
  PENDING_APPROVAL: {
    label: "Pending approval",
    icon: ShieldQuestion,
    tone: "text-muted-foreground",
  },
  CREDENTIALS_UNAVAILABLE: {
    label: "Credentials unavailable",
    icon: KeyRound,
    tone: "text-muted-foreground",
  },
  DISABLED: { label: "Disabled", icon: PauseCircle, tone: "text-muted-foreground" },
  NOT_SELECTED: { label: "Not selected", icon: CircleSlash, tone: "text-muted-foreground" },
  NOT_SEARCHED: { label: "Not searched", icon: CircleSlash, tone: "text-muted-foreground" },
};

const SEARCHED = new Set<MarketplaceState>(["SEARCHING", "COMPLETED", "FAILED", "TIMED_OUT"]);

export interface MarketplaceRow {
  slug: string;
  name: string;
  state: MarketplaceState;
  resultCount: number;
  detail: string | null;
  isSample: boolean;
}

/** Skip reason codes of the connector registry → displayed state + explanation. */
function skipped(
  code: string | null,
  message: string | null,
): { state: MarketplaceState; detail: string | null } {
  switch (code) {
    case "SOURCE_NOT_ACTIVE":
      return fromConnectorStatus(message ?? "");
    case "NOT_CONFIGURED":
      return { state: "CREDENTIALS_UNAVAILABLE", detail: "API credentials aren't configured" };
    case "PENDING_APPROVAL":
      return {
        state: "PENDING_APPROVAL",
        detail: message ?? "The marketplace hasn't approved access yet",
      };
    case "CONNECTOR_DISABLED":
      return { state: "DISABLED", detail: "Turned off by an administrator" };
    case "MOCK_NOT_ALLOWED":
      return { state: "DISABLED", detail: "Mock data is turned off in this environment" };
    case "CATEGORY_NOT_SUPPORTED":
      return { state: "NOT_SEARCHED", detail: "Doesn't cover this category" };
    case "CIRCUIT_OPEN":
      return { state: "NOT_SEARCHED", detail: "Paused after repeated failures; retried later" };
    case "EXCLUDED_BY_USER":
    case "NOT_REQUESTED":
      return { state: "NOT_SELECTED", detail: null };
    case "NO_CONNECTOR":
    case "NOT_SUPPORTED":
    case "NO_SEARCH_CAPABILITY":
      return { state: "NOT_SEARCHED", detail: "No authorized search integration" };
    default:
      return { state: "NOT_SEARCHED", detail: message };
  }
}

function fromConnectorStatus(status: string): { state: MarketplaceState; detail: string | null } {
  switch (status) {
    case "PENDING_APPROVAL":
      return { state: "PENDING_APPROVAL", detail: "The marketplace hasn't approved access yet" };
    case "PENDING_CREDENTIALS":
      return { state: "CREDENTIALS_UNAVAILABLE", detail: "API credentials aren't configured" };
    case "DISABLED":
      return { state: "DISABLED", detail: "No authorized integration" };
    case "MAINTENANCE":
      return { state: "DISABLED", detail: "Paused for maintenance" };
    case "FAILED":
      return { state: "NOT_SEARCHED", detail: "Integration is failing health checks" };
    default:
      return { state: "NOT_SEARCHED", detail: null };
  }
}

const ORDER: Record<MarketplaceState, number> = {
  COMPLETED: 0,
  SEARCHING: 1,
  WAITING: 2,
  TIMED_OUT: 3,
  FAILED: 4,
  NOT_SELECTED: 5,
  PENDING_APPROVAL: 6,
  CREDENTIALS_UNAVAILABLE: 7,
  DISABLED: 8,
  NOT_SEARCHED: 9,
};

export function marketplaceRows(
  detail: SearchDetail,
  live: Progress,
  sources: SourceStatus["sources"],
  running: boolean,
): MarketplaceRow[] {
  const known = new Map(sources.map((s) => [s.slug, s]));
  const selected = Array.isArray(detail.filters.sourceSlugs)
    ? (detail.filters.sourceSlugs as unknown[]).filter((x): x is string => typeof x === "string")
    : null;
  const persisted = new Map(detail.sourceRuns.map((r) => [r.source.slug, r]));
  const slugs = new Set([...known.keys(), ...persisted.keys(), ...Object.keys(live.sources)]);
  const planned = Object.keys(live.sources).length > 0 || persisted.size > 0;

  const rows = [...slugs].map((slug): MarketplaceRow => {
    const src = known.get(slug);
    const run = persisted.get(slug);
    const ev = live.sources[slug];
    const base = {
      slug,
      name: run?.source.name ?? src?.name ?? slug,
      isSample: run?.source.isSample ?? src?.isSample ?? false,
      resultCount: 0,
    };
    if (run) {
      if (run.status === "SKIPPED") return { ...base, ...skipped(run.errorCode, run.errorMessage) };
      const state: MarketplaceState =
        run.status === "SUCCEEDED"
          ? "COMPLETED"
          : run.status === "TIMED_OUT"
            ? "TIMED_OUT"
            : "FAILED";
      return { ...base, state, resultCount: run.resultCount, detail: run.errorMessage };
    }
    if (ev) {
      if (ev.status === "SKIPPED")
        return { ...base, ...fromConnectorStatus(src?.connectorStatus ?? "") };
      const state: MarketplaceState =
        ev.status === "PENDING"
          ? running
            ? "SEARCHING"
            : "NOT_SEARCHED"
          : ev.status === "SUCCEEDED"
            ? "COMPLETED"
            : ev.status === "TIMED_OUT"
              ? "TIMED_OUT"
              : "FAILED";
      return {
        ...base,
        state,
        resultCount: ev.resultCount,
        detail: state === "NOT_SEARCHED" ? "The search ended before it reported" : null,
      };
    }
    if (selected?.length && !selected.includes(slug))
      return { ...base, state: "NOT_SELECTED", detail: null };
    const status = src?.connectorStatus ?? "";
    if (status !== "ACTIVE" && status !== "DEGRADED")
      return { ...base, ...fromConnectorStatus(status) };
    if (running && !planned) return { ...base, state: "WAITING", detail: null };
    return {
      ...base,
      state: "NOT_SEARCHED",
      detail: planned
        ? "Not included in this search"
        : "The search ended before marketplaces were chosen",
    };
  });
  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}

export function SearchProgressPanel({
  detail,
  live,
  running,
}: {
  detail: SearchDetail;
  live: Progress;
  running: boolean;
}) {
  const status = useSourceStatus();
  const rows = marketplaceRows(detail, live, status.data?.sources ?? [], running);
  const searched = rows.filter((r) => SEARCHED.has(r.state));
  const failed = rows.filter((r) => r.state === "FAILED" || r.state === "TIMED_OUT");
  const notSearched = rows.filter((r) => !SEARCHED.has(r.state) && r.state !== "WAITING");
  const showTimeline = running || live.eventCount > 0;
  return (
    <section
      aria-labelledby="progress-title"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="progress-title" className="text-sm font-semibold">
          {running ? "Search progress" : "Marketplaces"}
        </h2>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {searched.length} searched
          {failed.length ? ` · ${failed.length} failed` : ""}
          {notSearched.length ? ` · ${notSearched.length} not searched` : ""}
        </p>
      </div>
      {showTimeline ? (
        <SearchTimeline progress={live} status={detail.status} createdAt={detail.createdAt} />
      ) : null}
      {running && live.error ? (
        <p className="text-xs text-muted-foreground">
          Live updates were interrupted; this page refreshes every few seconds instead.
        </p>
      ) : null}
      {status.isPending && !rows.length ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" /> Loading marketplaces…
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Marketplace status">
          {rows.map((r) => {
            const st = STATE[r.state];
            const Icon = st.icon;
            return (
              <li
                key={r.slug}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm",
                  !SEARCHED.has(r.state) && "bg-muted/40",
                )}
              >
                <Icon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0",
                    st.tone,
                    r.state === "SEARCHING" && "animate-spin",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{r.name}</span>
                    {r.isSample ? (
                      <Badge tone="warning" className="shrink-0">
                        Mock
                      </Badge>
                    ) : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {st.label}
                    {r.state === "COMPLETED"
                      ? ` · ${r.resultCount} listing${r.resultCount === 1 ? "" : "s"}`
                      : ""}
                    {r.detail ? ` · ${r.detail}` : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {failed.length ? (
        <Badge tone="warning" className="self-start whitespace-normal">
          {failed.map((f) => f.name).join(", ")} failed — results from the other marketplaces are
          still shown
        </Badge>
      ) : null}
      {notSearched.some((r) => r.state !== "NOT_SELECTED") ? (
        <p className="text-xs text-muted-foreground">
          Marketplaces marked “not searched” have no authorized integration available for this
          search. DealMind only uses approved APIs and affiliate feeds, never scraping.
        </p>
      ) : null}
    </section>
  );
}
