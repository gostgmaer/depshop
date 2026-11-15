"""Node 10: deterministic ranking (TypeScript ranking engine). The engine
reloads offers and prices from the database, re-applies the hard filters to
those prices and explains every rank; the agent passes ids, filters and the
user's stated eligibility only. Affiliate status never influences rank."""

from __future__ import annotations

from typing import Any

from app.nodes.calculate_discounts import eligibility_of
from app.nodes.deps import AgentDeps
from app.schemas.intent import ShoppingFilters
from app.state.state import ShoppingSearchState

# Engine warnings worth showing to the user (others are internal notes).
_USER_WARNINGS = ("TRENDING_DATA_UNAVAILABLE", "LAUNCH_DATE_UNKNOWN", "NO_VERIFIABLE_MRP")


def hard_filters(f: ShoppingFilters) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if f.min_price_paise is not None:
        out["minPricePaise"] = f.min_price_paise
    if f.max_price_paise is not None:
        out["maxPricePaise"] = f.max_price_paise
    if f.brands:
        out["brands"] = f.brands
    if f.excluded_brands:
        out["excludedBrands"] = f.excluded_brands
    if f.required_specs:
        out["requiredSpecs"] = f.required_specs
    if f.excluded_specs:
        out["excludedSpecs"] = f.excluded_specs
    if f.source_slugs:
        out["sourceSlugs"] = f.source_slugs
    if f.excluded_source_slugs:
        out["excludedSourceSlugs"] = f.excluded_source_slugs
    if f.category_slug:
        out["categorySlugs"] = [f.category_slug]
    return out


async def rank_deals(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    filters = ShoppingFilters.model_validate(state["filters"])
    eligibility = eligibility_of(filters)
    result = await deps.intelligence.rank(
        # Relevance is measured against the planned keywords, not filler words of the sentence.
        filters.keywords,
        filters.sort_mode,
        state.get("candidate_offer_ids", []),
        filters=hard_filters(filters),
        eligibility=eligibility,
        # With stated eligibility, compare what the user would actually pay (verified offers only).
        price_basis="best_verified" if eligibility else None,
        correlation_id=state["execution_id"],
    )
    if result is None:
        return {"ranked_deals": [], "ranking_token": None}
    warnings = [w.split(":", 1)[1].strip() for w in result.warnings if w.startswith(_USER_WARNINGS)]
    return {
        "ranked_deals": [r.model_dump(by_alias=True) for r in result.ranked[: deps.max_results]],
        "ranking_token": result.ranking_token,
        "warnings": warnings,
    }
