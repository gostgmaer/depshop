"""Node 4: ask the connector registry (TypeScript) which sources are eligible.
Nothing is hardcoded: availability comes from ShoppingSource + connector readiness."""

from __future__ import annotations

from typing import Any

from app.nodes.deps import AgentDeps
from app.schemas.intent import SearchPlan, ShoppingFilters
from app.schemas.internal import MarketplaceRequest
from app.state.state import ShoppingSearchState


def marketplace_request(filters: ShoppingFilters, plan: SearchPlan, query: str) -> MarketplaceRequest:
    return MarketplaceRequest(
        query=query,
        category=plan.category_slug,
        brands=filters.brands or None,
        min_price_paise=filters.min_price_paise,
        max_price_paise=filters.max_price_paise,
        limit=plan.limit_per_source,
    )


async def source_discovery(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    filters = ShoppingFilters.model_validate(state["filters"])
    plan = SearchPlan.model_validate(state["plan"])
    eligibility = await deps.marketplace.eligible_sources(
        marketplace_request(filters, plan, plan.queries[0]),
        only=filters.source_slugs,
        correlation_id=state["execution_id"],
    )
    selected = [s.source_id for s in eligibility.eligible if s.source_id not in filters.excluded_source_slugs]
    skipped = [s.model_dump(by_alias=True) for s in eligibility.skipped]
    skipped += [
        {"sourceId": s.source_id, "name": s.name, "reason": "EXCLUDED_BY_USER", "detail": None}
        for s in eligibility.eligible
        if s.source_id in filters.excluded_source_slugs
    ]
    return {
        "selected_sources": selected,
        "skipped_sources": skipped,
        "next_action": "search" if selected else "no_sources",
        "execution_metadata": {
            "sources": {
                "eligible": selected,
                "mock": [s.source_id for s in eligibility.eligible if s.is_mock],
            }
        },
    }
