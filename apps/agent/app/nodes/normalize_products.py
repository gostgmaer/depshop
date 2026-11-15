"""Node 6: product normalization by the existing catalog normalizer (TypeScript):
canonical brand, normalized name, canonical variant attributes and key."""

from __future__ import annotations

from typing import Any

from app.nodes.deps import AgentDeps
from app.schemas.internal import MarketplaceProduct
from app.state.state import ShoppingSearchState


async def normalize_products(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    products = [MarketplaceProduct.model_validate(p) for p in state.get("products", [])]
    category = (state.get("plan") or {}).get("category_slug")
    results = await deps.intelligence.normalize(products, category, correlation_id=state["execution_id"])
    failed = [r for r in results if not r.ok]
    return {
        "normalized": [r.model_dump(by_alias=True) for r in results],
        "warnings": [f"{len(failed)} listing(s) could not be normalized and were ignored."] if failed else [],
    }
