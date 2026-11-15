"""Node 9: discounts from the deterministic pricing engine (TypeScript).

The engine compares each offer's current price with its own price history:
an MRP discount alone is never called genuine. Discount requirements from the
user are applied to those computed values; recency is checked only when a
launch date is actually known.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from app.nodes.deps import AgentDeps
from app.schemas.intent import ShoppingFilters
from app.state.state import ShoppingSearchState

CONFIRMED_STOCK = {"IN_STOCK", "LIMITED"}


def bump(counter: dict[str, int], key: str) -> None:
    counter[key] = counter.get(key, 0) + 1


def eligibility_of(filters: ShoppingFilters) -> dict[str, list[str]] | None:
    """User-stated eligibility for conditional offers (absent keys = unknown, never assumed)."""
    out: dict[str, list[str]] = {}
    if filters.user_banks:
        out["banks"] = filters.user_banks
    if filters.user_card_types:
        out["cardTypes"] = list(filters.user_card_types)
    if filters.user_memberships:
        out["memberships"] = filters.user_memberships
    return out or None


async def calculate_discounts(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    filters = ShoppingFilters.model_validate(state["filters"])
    facts = await deps.intelligence.pricing(
        state.get("candidate_offer_ids", []),
        eligibility=eligibility_of(filters),
        correlation_id=state["execution_id"],
    )
    report = dict(state.get("filter_report") or {})
    removed: dict[str, int] = dict(report.get("removed") or {})
    warnings: list[str] = []
    kept = []
    cutoff = datetime.now(UTC) - timedelta(days=deps.recently_launched_days)
    unknown_launch = 0
    window_cutoff = (
        datetime.now(UTC) - timedelta(days=filters.launched_within_days)
        if filters.launched_within_days
        else None
    )
    for f in facts:
        if filters.in_stock_only and f.stock_status not in CONFIRMED_STOCK:
            bump(removed, "availability_not_confirmed")
            continue
        if window_cutoff is not None:
            # An explicit launch window is a hard requirement: an unknown date can't satisfy it.
            if f.launch_date is None:
                bump(removed, "launch_date_unknown")
                continue
            if datetime.fromisoformat(f.launch_date.replace("Z", "+00:00")) < window_cutoff:
                bump(removed, "launched_before_window")
                continue
        p = f.pricing.assessment
        if filters.genuine_discount_only and p.verdict != "GENUINE":
            removed[f"discount_{p.verdict.lower()}"] = removed.get(f"discount_{p.verdict.lower()}", 0) + 1
            continue
        if filters.min_discount_bp is not None:
            direct = f.pricing.direct_discount.percent_bp or 0
            value = p.genuine_discount_bp if filters.genuine_discount_only else direct
            if value < filters.min_discount_bp:
                removed["below_min_discount"] = removed.get("below_min_discount", 0) + 1
                continue
        if filters.launch_preference == "recently_launched":
            if f.launch_date is None:
                unknown_launch += 1
            elif datetime.fromisoformat(f.launch_date.replace("Z", "+00:00")) < cutoff:
                removed["not_recently_launched"] = removed.get("not_recently_launched", 0) + 1
                continue
        kept.append(f)
    if unknown_launch:
        warnings.append(
            f"Launch dates are unknown for {unknown_launch} product(s), "
            "so 'recently launched' couldn't be verified for them."
        )
    if removed.get("launch_date_unknown"):
        warnings.append(
            f"{removed['launch_date_unknown']} offer(s) were left out because the product's launch date "
            "is unknown, so the launch-date filter couldn't be verified."
        )
    if filters.genuine_discount_only and not kept and facts:
        warnings.append("No offer has enough price history to verify a genuine discount yet.")
    return {
        "priced_offers": [f.model_dump(by_alias=True) for f in kept],
        "candidate_offer_ids": [f.offer_id for f in kept],
        "filter_report": {**report, "removed": removed, "kept": len(kept)},
        "warnings": warnings,
    }
