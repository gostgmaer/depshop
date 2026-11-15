"""Typed LangGraph state for the shopping search graph.

Everything is plain JSON-compatible data (dicts/lists), so it checkpoints
cleanly. There is deliberately no tenant, organization or membership field:
DealMind is single-platform, multi-user.
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, NotRequired, TypedDict

SearchStatus = Literal[
    "PENDING", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "NEEDS_CLARIFICATION", "CANCELLED"
]


class AgentError(TypedDict):
    """A recorded failure: a source, a node or the LLM provider."""

    stage: str
    code: str
    message: str
    source_id: NotRequired[str]


def merge_dicts(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    """Deep merge (nested dicts merged, other values replaced)."""
    out = dict(left)
    for key, value in right.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge_dicts(out[key], value)
        else:
            out[key] = value
    return out


def merge_products(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Accumulates connector items across iterations, unique by (source, external id)."""
    seen = {(p["sourceId"], p["externalId"]) for p in left}
    return left + [p for p in right if (p["sourceId"], p["externalId"]) not in seen]


class ShoppingSearchState(TypedDict):
    # Identity (verified signed context; never taken from an unauthenticated client).
    user_id: str
    search_id: str
    execution_id: str
    user_context: str
    original_query: str
    explicit_filters: dict[str, Any]

    # Understanding.
    intent: NotRequired[dict[str, Any] | None]
    filters: NotRequired[dict[str, Any] | None]
    validation: NotRequired[dict[str, Any] | None]
    plan: NotRequired[dict[str, Any] | None]

    # Sources and search.
    selected_sources: NotRequired[list[str]]
    skipped_sources: NotRequired[list[dict[str, Any]]]
    source_runs: NotRequired[Annotated[list[dict[str, Any]], operator.add]]
    products: NotRequired[Annotated[list[dict[str, Any]], merge_products]]
    normalized: NotRequired[list[dict[str, Any]]]
    matched_groups: NotRequired[list[dict[str, Any]]]
    dedup_outcomes: NotRequired[list[dict[str, Any]]]
    candidate_offer_ids: NotRequired[list[str]]
    filter_report: NotRequired[dict[str, Any]]
    priced_offers: NotRequired[list[dict[str, Any]]]
    ranked_deals: NotRequired[list[dict[str, Any]]]

    # Control.
    iteration: NotRequired[int]
    next_action: NotRequired[str]
    search_status: NotRequired[SearchStatus]
    errors: NotRequired[Annotated[list[AgentError], operator.add]]
    warnings: NotRequired[Annotated[list[str], operator.add]]

    # Output.
    response: NotRequired[str | None]
    clarification_question: NotRequired[str | None]
    persisted: NotRequired[bool]

    # Observability: node timings, token usage, provider/model, iterations.
    execution_metadata: NotRequired[Annotated[dict[str, Any], merge_dicts]]
