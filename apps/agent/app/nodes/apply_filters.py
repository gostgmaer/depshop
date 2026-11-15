"""Node 8: hard user constraints, applied deterministically.

Uses only verified data: source prices from the connector executor and
canonical attributes from the catalog normalizer. A listing that doesn't
state a required specification is excluded (it can't be verified) and counted,
so the response can say so. Never relaxes a constraint.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from app.nodes.deps import AgentDeps
from app.nodes.query_validator import brand_key
from app.schemas.intent import ShoppingFilters
from app.state.state import ShoppingSearchState


def _value_matches(actual: Any, wanted: str | float) -> bool:
    if isinstance(wanted, int | float) and not isinstance(wanted, bool):
        try:
            return float(actual) == float(wanted)
        except (TypeError, ValueError):
            return False
    a, w = str(actual).lower().strip(), str(wanted).lower().strip()
    return a == w or re.sub(r"\s+", "", a) == re.sub(r"\s+", "", w)


def check_offer(item: dict[str, Any], attrs: dict[str, Any], brand: str, f: ShoppingFilters) -> str | None:
    """Returns the reason an offer fails a hard constraint, or None if it passes."""
    price = int(item["sellingPricePaise"]) + int(item.get("shippingPaise") or 0)
    if f.min_price_paise is not None and price < f.min_price_paise:
        return "below_min_price"
    if f.max_price_paise is not None and price > f.max_price_paise:
        return "above_max_price"
    bk = brand_key(brand)
    if f.brands and bk not in {brand_key(b) for b in f.brands}:
        return "brand_not_requested"
    if bk in {brand_key(b) for b in f.excluded_brands}:
        return "brand_excluded"
    for key, wanted in f.required_specs.items():
        if key not in attrs:
            return "spec_not_stated"
        if not _value_matches(attrs[key], wanted):
            return "spec_mismatch"
    for key, unwanted in f.excluded_specs.items():
        if key in attrs and _value_matches(attrs[key], unwanted):
            return "spec_excluded"
    return None


async def apply_filters(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    filters = ShoppingFilters.model_validate(state["filters"])
    products = state.get("products", [])
    normalized = {n["index"]: n for n in state.get("normalized", []) if n.get("ok")}
    kept: list[str] = []
    reasons: Counter[str] = Counter()
    for outcome in state.get("dedup_outcomes", []):
        if outcome["status"] != "imported" or not outcome.get("offerId"):
            reasons[f"not_matched:{outcome['status']}"] += 1
            continue
        index = outcome["index"]
        item = products[index]
        norm = normalized.get(index, {})
        reason = check_offer(item, norm.get("attributes") or {}, norm.get("brand") or item["brand"], filters)
        if reason:
            reasons[reason] += 1
        elif outcome["offerId"] not in kept:
            kept.append(outcome["offerId"])
    note = None
    if reasons.get("spec_not_stated"):
        note = (
            f"{reasons['spec_not_stated']} listing(s) were left out because they don't state a required "
            "specification, so it couldn't be verified."
        )
    return {
        "candidate_offer_ids": kept,
        "filter_report": {"kept": len(kept), "removed": dict(reasons), "note": note},
    }
