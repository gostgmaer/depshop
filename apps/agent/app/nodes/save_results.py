"""Node 13: persist through the Fastify internal API (the owner of user-facing
records). Idempotent (results replaced in one transaction); the API re-checks
the signed user context and ownership, and takes prices from the database."""

from __future__ import annotations

import time
from typing import Any

from app.nodes.deps import AgentDeps
from app.nodes.evaluate_results import final_source_status
from app.state.state import ShoppingSearchState


def explain(deal: dict[str, Any]) -> str:
    b, p = deal["breakdown"], deal["offer"]["pricing"]
    verdict = {
        "GENUINE": "genuine discount vs typical price",
        "NOT_GENUINE": "no real discount vs typical price",
        "INSUFFICIENT_HISTORY": "discount not yet verifiable",
    }[p["verdict"]]
    return (
        f"Score {deal['score']}: relevance {b['relevance'] // 100}%, price position {b['price'] // 100}%, "
        f"{verdict}, availability {b['availability'] // 100}%."
    )


def aggregate_source_runs(state: ShoppingSearchState) -> list[dict[str, Any]]:
    runs = state.get("source_runs", [])
    final = final_source_status(runs)
    out: dict[str, dict[str, Any]] = {}
    for r in runs:
        agg = out.setdefault(
            r["sourceId"],
            {
                "sourceId": r["sourceId"],
                "status": final[r["sourceId"]],
                "resultCount": 0,
                "durationMs": 0,
                "errorCode": None,
                "errorMessage": None,
            },
        )
        agg["resultCount"] += int(r.get("resultCount") or 0)
        agg["durationMs"] += int(r.get("durationMs") or 0)
        if r["status"] != "SUCCEEDED" and agg["status"] != "SUCCEEDED":
            agg["errorCode"], agg["errorMessage"] = r.get("errorCode"), r.get("errorMessage")
    for s in state.get("skipped_sources", []):
        out.setdefault(
            s["sourceId"],
            {
                "sourceId": s["sourceId"],
                "status": "SKIPPED",
                "resultCount": 0,
                "durationMs": 0,
                "errorCode": s["reason"],
                "errorMessage": s.get("detail"),
            },
        )
    return list(out.values())


def build_payload(state: ShoppingSearchState, status: str) -> dict[str, Any]:
    meta = state.get("execution_metadata") or {}
    tokens = meta.get("tokens", {})
    llm = meta.get("llm", {})
    started = meta.get("started_at_epoch")
    duration = max(0, int((time.time() - started) * 1000)) if isinstance(started, int | float) else 0
    errors = state.get("errors", [])
    deals = state.get("ranked_deals", []) if status in ("COMPLETED", "PARTIAL") else []
    return {
        "status": status,
        "interpretation": {
            "intent": state.get("intent"),
            "filters": state.get("filters"),
            "plan": state.get("plan"),
        }
        if state.get("intent")
        else None,
        "clarificationQuestion": state.get("clarification_question"),
        "response": state.get("response"),
        "warnings": list(dict.fromkeys(state.get("warnings", [])))[:50],
        "rankedDeals": [
            {
                "offerId": d["offer"]["offerId"],
                "rank": i + 1,
                "score": max(0, min(10_000, int(d["score"]))),
                "explanation": explain(d),
            }
            for i, d in enumerate(deals)
        ],
        "sourceRuns": aggregate_source_runs(state),
        "agentRun": {
            "provider": str(llm.get("provider", "")),
            "model": str(llm.get("model", "")),
            "inputTokens": sum(int(v[0]) for v in tokens.values()),
            "outputTokens": sum(int(v[1]) for v in tokens.values()),
            "durationMs": duration,
            "metadata": dict(meta) | {"errors": errors[:20], "filterReport": state.get("filter_report")},
            "error": errors[-1]["message"][:2000] if status == "FAILED" and errors else None,
        },
    }


async def save_results(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    status = state.get("search_status", "FAILED")
    if status in ("PENDING", "RUNNING"):
        status = "FAILED"
    payload = build_payload(state, status)
    await deps.intelligence.save_result(
        state["search_id"], payload, user_context=state["user_context"], correlation_id=state["execution_id"]
    )
    return {"persisted": True, "search_status": status}
