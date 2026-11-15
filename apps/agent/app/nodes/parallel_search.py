"""Node 5: search every selected source in parallel through the TypeScript
connector executor (bounded concurrency, per-source timeout, failure isolation)."""

from __future__ import annotations

from typing import Any

from app.nodes.deps import AgentDeps
from app.nodes.source_discovery import marketplace_request
from app.schemas.intent import SearchPlan, ShoppingFilters
from app.state.state import AgentError, ShoppingSearchState


async def parallel_search(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    filters = ShoppingFilters.model_validate(state["filters"])
    plan = SearchPlan.model_validate(state["plan"])
    iteration = state.get("iteration", 0)
    query = plan.queries[min(iteration, len(plan.queries) - 1)]
    result = await deps.marketplace.search_many(
        marketplace_request(filters, plan, query),
        state.get("selected_sources", []),
        correlation_id=f"{state['execution_id']}:it{iteration}",
    )
    errors: list[AgentError] = [
        {
            "stage": "parallel_search",
            "code": r.error_code or r.status,
            "message": (r.error_message or r.status)[:300],
            "source_id": r.source_id,
        }
        for r in result.sources
        if r.status in ("FAILED", "TIMED_OUT")
    ]
    runs = [{**r.model_dump(by_alias=True), "iteration": iteration, "query": query} for r in result.sources]
    return {
        "products": [i.wire() for i in result.items],
        "source_runs": runs,
        "errors": errors,
        "iteration": iteration + 1,
        "execution_metadata": {"search_ms": {f"it{iteration}": result.duration_ms}},
    }
