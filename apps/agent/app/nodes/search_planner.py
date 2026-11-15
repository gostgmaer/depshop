"""Node 3: plan the search (deterministic): query variants from precise to
broad, depth and per-source limits. Later iterations use broader variants."""

from __future__ import annotations

import re
from typing import Any

from app.nodes.deps import AgentDeps
from app.schemas.intent import SearchPlan, ShoppingFilters
from app.state.state import ShoppingSearchState


def _spec_words(filters: ShoppingFilters) -> list[str]:
    words: list[str] = []
    for key, value in filters.required_specs.items():
        if key == "ram_gb":
            words.append(f"{value:g}GB RAM" if isinstance(value, float) else f"{value}GB RAM")
        elif key == "storage_gb":
            words.append(f"{value:g}GB" if isinstance(value, float) else f"{value}GB")
        elif key == "capacity_ton":
            words.append(f"{value:g} ton" if isinstance(value, float) else f"{value} ton")
        elif key == "capacity_kg":
            words.append(f"{value:g} kg" if isinstance(value, float) else f"{value} kg")
        elif key == "capacity_l":
            words.append(f"{value:g} L" if isinstance(value, float) else f"{value} L")
    return words


def build_plan(filters: ShoppingFilters, min_results: int) -> SearchPlan:
    base = " ".join(filters.keywords.split())
    precise = base
    for w in _spec_words(filters):
        if w.lower().split()[0] not in precise.lower():
            precise = f"{precise} {w}"
    broad_parts = [*filters.brands[:2], filters.model or "", filters.product_type or ""]
    broad = " ".join(p for p in broad_parts if p) or re.sub(r"\d+\s*(gb|tb)\b", "", base, flags=re.I)
    broadest = (filters.product_type or (filters.category_slug or "").replace("-", " ")).strip()
    queries: list[str] = []
    for q in (precise, broad, broadest):
        q = " ".join(q.split())
        if len(q) >= 2 and q.lower() not in [x.lower() for x in queries]:
            queries.append(q[:200])
    deep = filters.sort_mode == "highest_discount" or filters.compare_same_product
    return SearchPlan(
        queries=queries[:3] or [base],
        category_slug=filters.category_slug,
        limit_per_source=40 if deep else 20,
        depth="deep" if deep else "standard",
        min_results=2 if filters.compare_same_product else min_results,
    )


async def search_planner(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    filters = ShoppingFilters.model_validate(state["filters"])
    plan = build_plan(filters, deps.min_results)
    return {"plan": plan.model_dump(), "iteration": 0, "search_status": "RUNNING"}
