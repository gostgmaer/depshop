"""Node 11: decide what happens next (bounded).

  - too few results, iterations left, a broader query variant available and
    at least one source working → search again ("search_more");
  - otherwise finish: COMPLETED, PARTIAL (some sources failed) or FAILED
    (every searched source failed).
The iteration cap (AGENT_MAX_ITERATIONS) plus LangGraph's recursion limit
make infinite loops impossible.
"""

from __future__ import annotations

from typing import Any

from app.nodes.deps import AgentDeps
from app.state.state import ShoppingSearchState


def final_source_status(runs: list[dict[str, Any]]) -> dict[str, str]:
    """Per source: SUCCEEDED if any iteration succeeded, else its last status."""
    out: dict[str, str] = {}
    for r in runs:
        if out.get(r["sourceId"]) == "SUCCEEDED":
            continue
        out[r["sourceId"]] = r["status"]
    return out


async def evaluate_results(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    iteration = state.get("iteration", 1)
    plan = state.get("plan") or {}
    ranked = state.get("ranked_deals", [])
    statuses = final_source_status(state.get("source_runs", []))
    searched = {k: v for k, v in statuses.items() if v != "SKIPPED"}
    succeeded = [k for k, v in searched.items() if v == "SUCCEEDED"]
    failed = [k for k, v in searched.items() if v in ("FAILED", "TIMED_OUT")]

    can_retry = (
        iteration < deps.max_iterations and iteration < len(plan.get("queries", [])) and bool(succeeded)
    )
    if len(ranked) < int(plan.get("min_results", deps.min_results)) and can_retry:
        return {"next_action": "search_more", "execution_metadata": {"iterations": iteration}}

    if searched and not succeeded:
        status = "FAILED"
    elif failed:
        status = "PARTIAL"
    else:
        status = "COMPLETED"
    return {
        "next_action": "respond",
        "search_status": status,
        "execution_metadata": {"iterations": iteration},
    }
