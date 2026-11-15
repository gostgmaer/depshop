"""Node 10: deterministic ranking (TypeScript ranking engine). The engine
reloads offers and prices from the database itself; the agent passes ids only.
Affiliate status never influences rank."""

from __future__ import annotations

from typing import Any

from app.nodes.deps import AgentDeps
from app.schemas.intent import ShoppingFilters
from app.state.state import ShoppingSearchState


async def rank_deals(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    filters = ShoppingFilters.model_validate(state["filters"])
    ranked = await deps.intelligence.rank(
        # Relevance is measured against the planned keywords, not filler words of the sentence.
        filters.keywords,
        filters.sort_mode,
        state.get("candidate_offer_ids", []),
        correlation_id=state["execution_id"],
    )
    return {"ranked_deals": [r.model_dump(by_alias=True) for r in ranked[: deps.max_results]]}
