"use client";

/**
 * The search pipeline as the agent actually reports it. A step is "done" only
 * when the agent sent node_finished for its last node; nothing is estimated
 * (there are deliberately no percentages or time predictions).
 */
import { CheckCircle2, Circle, CircleDashed, CircleSlash, Loader2 } from "lucide-react";
import type { SearchProgress } from "@/hooks/use-search-events";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * not_reached: the search ended (failed, cancelled, needs clarification) first.
 * not_reported: the search succeeded but no event for this step was received
 * (e.g. the replay log expired) — it isn't claimed done or skipped.
 */
export type StepState = "done" | "active" | "pending" | "not_reached" | "not_reported";

export interface TimelineStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
}

const STEPS: { id: string; label: string; nodes: string[] }[] = [
  {
    id: "understand",
    label: "AI understanding the query",
    nodes: ["intent_extractor", "query_validator"],
  },
  { id: "plan", label: "Search plan created", nodes: ["search_planner", "source_discovery"] },
  { id: "search", label: "Marketplace searches", nodes: ["parallel_search"] },
  { id: "match", label: "Products matched", nodes: ["normalize_products", "deduplicate"] },
  { id: "price", label: "Prices calculated", nodes: ["apply_filters", "calculate_discounts"] },
  { id: "rank", label: "Results ranked", nodes: ["rank_deals"] },
];

const SUCCESS = new Set(["COMPLETED", "PARTIAL"]);
const TERMINAL = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"]);

export function timelineSteps(
  progress: SearchProgress,
  status: string,
  createdAt?: string,
): TimelineStep[] {
  const finished = new Set(progress.completedStages);
  const started = new Set(progress.startedStages);
  const terminal = TERMINAL.has(status);
  const sources = Object.values(progress.sources);
  const planned = sources.filter((s) => s.status !== "SKIPPED");
  const reported = planned.filter((s) => s.status !== "PENDING");

  const steps: TimelineStep[] = [
    {
      id: "accepted",
      label: "Search accepted",
      state: "done",
      ...(createdAt ? { detail: formatDateTime(createdAt) } : {}),
    },
  ];
  for (const step of STEPS) {
    const last = step.nodes[step.nodes.length - 1]!;
    const state: StepState =
      !terminal && progress.running && step.nodes.includes(progress.running)
        ? "active"
        : finished.has(last)
          ? "done"
          : step.nodes.some((n) => started.has(n)) && !terminal
            ? "active"
            : terminal
              ? SUCCESS.has(status)
                ? "not_reported"
                : "not_reached"
              : "pending";
    const detail =
      step.id === "search" && planned.length
        ? `${reported.length} of ${planned.length} marketplace${planned.length === 1 ? "" : "s"} reported`
        : undefined;
    steps.push({ id: step.id, label: step.label, state, ...(detail ? { detail } : {}) });
  }
  steps.push({
    id: "final",
    label: "Final results available",
    state: SUCCESS.has(status) ? "done" : terminal ? "not_reached" : "pending",
    ...(status === "PARTIAL" ? { detail: "Partial: some marketplaces failed" } : {}),
  });
  return steps;
}

const ICON: Record<StepState, typeof Circle> = {
  done: CheckCircle2,
  active: Loader2,
  pending: Circle,
  not_reached: CircleSlash,
  not_reported: CircleDashed,
};
const STATE_TEXT: Record<StepState, string> = {
  done: "done",
  active: "in progress",
  pending: "waiting",
  not_reached: "not reached",
  not_reported: "not reported",
};

export function SearchTimeline({
  progress,
  status,
  createdAt,
}: {
  progress: SearchProgress;
  status: string;
  createdAt: string;
}) {
  const steps = timelineSteps(progress, status, createdAt);
  return (
    <ol
      aria-label="Search progress"
      className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:gap-x-4 sm:gap-y-1"
    >
      {steps.map((s) => {
        const Icon = ICON[s.state];
        return (
          <li
            key={s.id}
            className={cn(
              "flex items-center gap-1.5 text-xs",
              s.state === "done" && "text-foreground",
              s.state === "active" && "font-medium text-accent",
              s.state !== "done" && s.state !== "active" && "text-muted-foreground",
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0",
                s.state === "done" && "text-primary",
                s.state === "active" && "animate-spin",
              )}
            />
            <span>
              {s.label}
              <span className="sr-only">: {STATE_TEXT[s.state]}</span>
              {s.state === "not_reported" ? (
                <span className="text-muted-foreground"> · not reported</span>
              ) : null}
              {s.detail ? <span className="text-muted-foreground"> · {s.detail}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
