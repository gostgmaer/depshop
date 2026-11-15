"""Node 12: readable explanation from verified structured results only.
A deterministic template always exists; LLM narration is validated against
the facts (no invented figures, no URLs) or discarded."""

from __future__ import annotations

from typing import Any

from app.nodes.deps import AgentDeps
from app.services.narrator import facts_for, narrate
from app.state.state import ShoppingSearchState

_SKIP_REASONS = {
    "SOURCE_NOT_ACTIVE": "not enabled",
    "NOT_CONFIGURED": "awaiting credentials",
    "PENDING_APPROVAL": "awaiting marketplace approval",
    "NOT_SUPPORTED": "not supported yet",
    "MOCK_NOT_ALLOWED": "mock source (disabled here)",
    "EXCLUDED_BY_USER": "excluded by you",
}


async def generate_response(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    status = state.get("search_status", "FAILED")
    if status == "NEEDS_CLARIFICATION":
        return {"response": state.get("clarification_question")}
    if state.get("next_action") == "fail":
        errors = state.get("errors") or []
        error = errors[-1]["message"] if errors else "unknown error"
        return {"search_status": "FAILED", "response": f"The search could not be run: {error}"}
    if state.get("next_action") == "no_sources":
        skipped = state.get("skipped_sources", [])
        detail = "; ".join(
            f"{s['name']} ({_SKIP_REASONS.get(s['reason'], s['reason'].lower())})" for s in skipped
        )
        return {
            "search_status": "COMPLETED",
            "response": "No shopping source is currently available to search"
            + (f": {detail}." if detail else ".")
            + " No results were produced.",
        }

    deals = state.get("ranked_deals", [])
    facts = facts_for(deals, status, state.get("source_runs", []))
    note = (state.get("filter_report") or {}).get("note")
    result = await narrate(deps.llm, facts, note, enabled=deps.narration)
    return {
        "response": result.text,
        "execution_metadata": {
            "narration": {"llm": result.narrated_by_llm, "rejected": result.rejected_reason},
            "tokens": {"generate_response": [result.usage.input_tokens, result.usage.output_tokens]},
        },
    }
