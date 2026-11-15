"use client";

/**
 * Live search progress from the API's Server-Sent Events stream
 * (GET /api/v1/search/:id/events, owner only, cookie-authenticated).
 * The reducer is pure so progress logic is testable without a browser.
 * If the stream fails, the page keeps working on polling (useSearch).
 */
import { TERMINAL_SEARCH_STATUSES, searchEvent } from "@dealmind/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer } from "react";
import { keys } from "@/hooks/queries";
import { searches } from "@/services";
import type { SearchEvent } from "@/types/api";

export type SourceProgress = "PENDING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "SKIPPED";

export interface SearchProgress {
  connected: boolean;
  /** Last pipeline step reported by the agent. */
  stage: string | null;
  completedStages: string[];
  sources: Record<string, { status: SourceProgress; resultCount: number }>;
  status: string | null;
  error: boolean;
}

export const initialProgress: SearchProgress = {
  connected: false,
  stage: null,
  completedStages: [],
  sources: {},
  status: null,
  error: false,
};

type Action = { kind: "event"; event: SearchEvent } | { kind: "connected" } | { kind: "error" };

export function progressReducer(state: SearchProgress, action: Action): SearchProgress {
  if (action.kind === "connected") return { ...state, connected: true, error: false };
  if (action.kind === "error") return { ...state, connected: false, error: true };
  const e = action.event;
  switch (e.type) {
    case "node_started":
      return { ...state, stage: e.node };
    case "node_finished":
      return state.completedStages.includes(e.node)
        ? state
        : { ...state, completedStages: [...state.completedStages, e.node] };
    case "sources_planned": {
      const sources = { ...state.sources };
      for (const s of e.sources) sources[s] ??= { status: "PENDING", resultCount: 0 };
      for (const s of e.skipped) sources[s] = { status: "SKIPPED", resultCount: 0 };
      return { ...state, sources };
    }
    case "source_finished": {
      // A later search round may add results for the same source.
      const prev = state.sources[e.source];
      const resultCount = (prev?.status === "SUCCEEDED" ? prev.resultCount : 0) + e.resultCount;
      const status: SourceProgress =
        prev?.status === "SUCCEEDED" && e.status !== "SUCCEEDED" ? "SUCCEEDED" : e.status;
      return { ...state, sources: { ...state.sources, [e.source]: { status, resultCount } } };
    }
    case "status":
      return { ...state, status: e.status };
  }
}

/** Human labels for the agent's pipeline steps. */
export const STAGE_LABEL: Record<string, string> = {
  intent_extractor: "Understanding your request",
  query_validator: "Checking requirements",
  search_planner: "Planning the search",
  source_discovery: "Choosing marketplaces",
  parallel_search: "Searching marketplaces",
  normalize_products: "Normalizing listings",
  deduplicate: "Matching identical products",
  apply_filters: "Applying your filters",
  calculate_discounts: "Verifying prices and discounts",
  rank_deals: "Ranking deals",
  evaluate_results: "Checking result quality",
  generate_response: "Writing the summary",
  save_results: "Saving results",
};

export function useSearchEvents(searchId: string, enabled: boolean): SearchProgress {
  const [state, dispatch] = useReducer(progressReducer, initialProgress);
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const source = new EventSource(searches.eventsUrl(searchId), { withCredentials: true });
    source.onopen = () => dispatch({ kind: "connected" });
    source.onerror = () => {
      dispatch({ kind: "error" });
      // The server closes the stream when the search ends; polling takes over.
      source.close();
    };
    source.onmessage = (msg: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      const event = searchEvent.safeParse(parsed);
      if (!event.success) return;
      dispatch({ kind: "event", event: event.data });
      if (event.data.type === "source_finished" || event.data.type === "status") {
        void qc.invalidateQueries({ queryKey: keys.search(searchId) });
        void qc.invalidateQueries({ queryKey: keys.searchResults(searchId) });
      }
      if (
        event.data.type === "status" &&
        (TERMINAL_SEARCH_STATUSES as readonly string[]).includes(event.data.status)
      ) {
        source.close();
      }
    };
    return () => source.close();
  }, [searchId, enabled, qc]);

  return state;
}
