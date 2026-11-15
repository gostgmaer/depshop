"""Node 7: deduplication by the existing catalog matching engine (TypeScript).
Listings become shared offers grouped per product and variant; different
variants are never merged; uncertain matches go to manual review."""

from __future__ import annotations

from typing import Any

from app.nodes.deps import AgentDeps
from app.schemas.internal import MarketplaceProduct
from app.state.state import ShoppingSearchState


async def deduplicate(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    products = [MarketplaceProduct.model_validate(p) for p in state.get("products", [])]
    category = (state.get("plan") or {}).get("category_slug")
    result = await deps.intelligence.deduplicate(products, category, correlation_id=state["execution_id"])
    offer_ids = list(
        dict.fromkeys(o.offer_id for o in result.outcomes if o.status == "imported" and o.offer_id)
    )
    review = sum(1 for o in result.outcomes if o.status == "review")
    return {
        "dedup_outcomes": [o.model_dump(by_alias=True) for o in result.outcomes],
        "matched_groups": [g.model_dump(by_alias=True) for g in result.groups],
        "candidate_offer_ids": offer_ids,
        "warnings": [f"{review} listing(s) had an uncertain product match and are held for review."]
        if review
        else [],
    }
