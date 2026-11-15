"""13. Conditional routing · 14. Bounded iterations · 15. Persistence · 16. User
context · 17. Internal API auth · 18. Provider failures (execution level) ·
checkpoint resume · cancellation · response grounding."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver

from app.graphs import shopping_search as g
from app.main import create_app
from app.providers.base import LlmError
from app.services.narrator import facts_for, format_rupees, template_summary, validate_narration
from app.utils.user_context import sign_user_context, verify_user_context
from tests.conftest import Ids, api_for, run_to_end, settings
from tests.fakes import SECRET, TOKEN, FakeBackend, ScriptedLlm, item


def intent_dict(**over: Any) -> dict[str, Any]:
    return {"search_keywords": "acme nova", "category": "smartphones", **over}


# ── 13. conditional routing ─────────────────────────────────────────────


def test_route_functions() -> None:
    assert g._after_intent({"next_action": "fail"}) == "generate_response"  # type: ignore[arg-type]
    assert g._after_intent({"next_action": "validate"}) == "query_validator"  # type: ignore[arg-type]
    assert g._after_validation({"next_action": "clarify"}) == "generate_response"  # type: ignore[arg-type]
    assert g._after_validation({"next_action": "plan"}) == "search_planner"  # type: ignore[arg-type]
    assert g._after_discovery({"next_action": "no_sources"}) == "generate_response"  # type: ignore[arg-type]
    assert g._after_search({"products": []}) == "evaluate_results"  # type: ignore[arg-type]
    assert g._after_search({"products": [{}]}) == "normalize_products"  # type: ignore[arg-type]
    assert g._after_evaluation({"next_action": "search_more"}) == "parallel_search"  # type: ignore[arg-type]
    assert g._after_evaluation({"next_action": "respond"}) == "generate_response"  # type: ignore[arg-type]


async def test_clarification_path_skips_searching(backend: FakeBackend, ids: Ids, make_service: Any) -> None:
    llm = ScriptedLlm(intent_dict(min_price_rupees=50_000, max_price_rupees=20_000))
    ex = await run_to_end(make_service(llm), ids.request("phone above ₹50,000 under ₹20,000"))
    assert (ex.status, ex.persisted) == ("NEEDS_CLARIFICATION", True)
    saved = backend.saved[ids.search][-1]
    assert saved["clarificationQuestion"] and saved["rankedDeals"] == []
    assert not backend.calls_to("/sources/eligible")
    assert llm.calls == ["intent_extractor"]  # no narration for a question


async def test_all_sources_failing_is_reported_as_failed(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    for s in backend.sources.values():
        s["fail"] = 500
    ex = await run_to_end(make_service(ScriptedLlm(intent_dict())), ids.request("acme nova"))
    saved = backend.saved[ids.search][-1]
    assert (ex.status, saved["status"], saved["rankedDeals"]) == ("FAILED", "FAILED", [])
    assert saved["agentRun"]["error"]


# ── 14. bounded iterations ──────────────────────────────────────────────


async def test_too_few_results_triggers_one_broader_search_then_stops(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    backend.sources = {"mock_alpha": {"items": [item("mock_alpha", "z", "Zenith Z9 Phone", "Zenith", 9_999)]}}
    i = intent_dict(search_keywords="zenith z9 phone", brands=["Zenith"], product_type="phone")
    svc = make_service(
        ScriptedLlm(i, {"summary": "fine results found"}), deps={"max_iterations": 2, "min_results": 5}
    )
    ex = await run_to_end(svc, ids.request("zenith z9 phone"))
    queries = [b["request"]["query"] for b in backend.calls_to("/marketplace/search")]
    assert queries == ["zenith z9 phone", "Zenith phone"]  # precise, then broader, then stop
    assert (ex.iterations, ex.persisted) == (2, True)


async def test_recursion_limit_is_a_hard_stop(backend: FakeBackend, ids: Ids, make_service: Any) -> None:
    svc = make_service(ScriptedLlm(intent_dict()), recursion_limit=3)
    ex = await run_to_end(svc, ids.request("acme nova"))
    assert ex.status == "FAILED"
    assert backend.saved[ids.search][-1]["response"] == "Execution exceeded its step limit"


# ── 15. persistence ─────────────────────────────────────────────────────


async def test_persistence_is_idempotent_and_includes_observability(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    svc = make_service(ScriptedLlm(intent_dict(), {"summary": "Three offers found."}))
    ex = await run_to_end(svc, ids.request("acme nova"))
    again = await svc.start(ids.request("acme nova"))
    assert again is ex  # same execution id → same execution, not re-run
    assert len(backend.saved[ids.search]) == 1
    run = backend.saved[ids.search][0]["agentRun"]
    assert (run["provider"], run["model"]) == ("fake", "fake-1")
    assert run["inputTokens"] == 240 and run["outputTokens"] == 80  # intent + narration
    assert set(run["metadata"]["node_ms"]) >= {
        "intent_extractor",
        "parallel_search",
        "rank_deals",
        "generate_response",
    }
    assert run["metadata"]["iterations"] == 1
    events = backend.events[ids.search]
    assert {e["type"] for e in events} == {
        "node_started",
        "node_finished",
        "sources_planned",
        "source_finished",
    }
    planned = next(e for e in events if e["type"] == "sources_planned")
    finished = [e for e in events if e["type"] == "source_finished"]
    # Every searched marketplace reports its own outcome (UI shows per-source progress).
    assert {e["source"] for e in finished} <= set(planned["sources"])
    assert all(e["status"] in ("SUCCEEDED", "FAILED", "TIMED_OUT", "SKIPPED") for e in finished)


async def test_resume_from_checkpoint_after_a_transient_failure(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    saver = InMemorySaver()
    llm = ScriptedLlm(intent_dict(), {"summary": "Three offers found."})
    backend.fail_paths["/intelligence/rank"] = 503
    svc = make_service(llm, checkpointer=saver)
    first = await run_to_end(svc, ids.request("acme nova"))
    assert (first.status, first.persisted) == ("FAILED", False)  # retryable: not persisted
    second = await run_to_end(make_service(llm, checkpointer=saver), ids.request("acme nova"))
    assert (second.status, second.persisted) == ("COMPLETED", True)
    assert llm.calls == ["intent_extractor", "generate_response"]  # intent NOT re-extracted after resume
    assert len(backend.calls_to("/marketplace/search")) == 2  # sources not searched again


async def test_cancellation_stops_at_next_node_and_is_persisted(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    backend.sources["mock_alpha"]["delay"] = 0.3
    svc = make_service(ScriptedLlm(intent_dict(), {"summary": "x results"}))
    ex = await svc.start(ids.request("acme nova"))
    await asyncio.sleep(0.1)
    assert svc.cancel(ids.execution)
    assert ex.task is not None
    await ex.task
    assert (ex.status, ex.persisted) == ("CANCELLED", True)
    assert backend.saved[ids.search][-1]["status"] == "CANCELLED"
    assert not svc.cancel(ids.execution)  # already finished


async def test_execution_timeout_fails_unpersisted(backend: FakeBackend, ids: Ids, make_service: Any) -> None:
    backend.sources["mock_alpha"]["delay"] = 1
    ex = await run_to_end(
        make_service(ScriptedLlm(intent_dict()), timeout_seconds=0.2), ids.request("acme nova")
    )
    assert (ex.status, ex.persisted) == ("FAILED", False)
    assert "timed out" in (ex.error or "")


# ── 16. user context ────────────────────────────────────────────────────

# Produced by packages/queue signUserContext (TypeScript) with secret "s"*40, exp 2100-01-01.
TS_TOKEN = (
    "eyJ1c2VySWQiOiIwMTkzYTFiMi1jM2Q0LTdlNWYtOGE5Yi0wYzFkMmUzZjRhNWIiLCJzZWFyY2hJZCI6IjAxOTNhMWIyLWMzZDQtN2U1Zi04Y"
    "TliLTBjMWQyZTNmNGE1YyIsImV4ZWN1dGlvbklkIjoiMDE5M2ExYjItYzNkNC03ZTVmLThhOWItMGMxZDJlM2Y0YTVkIiwiZXhwIjo0MTAyNDQ0ODAwfQ"
    ".JLCJEknhbLGrSps44HCq1XvADIedJE7XiifvjHReWxA"
)


def test_typescript_signed_context_verifies_in_python() -> None:
    ctx = verify_user_context(TS_TOKEN, SECRET)
    assert ctx is not None
    assert ctx.user_id == "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
    assert ctx.execution_id == "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d"
    # And Python produces the identical token for the same claims.
    assert sign_user_context(ctx.user_id, ctx.search_id, ctx.execution_id, ctx.exp, SECRET) == TS_TOKEN


def test_user_context_sign_verify_tamper_expiry() -> None:
    now = int(time.time())
    token = sign_user_context("u1", "s1", "e1", now + 60, SECRET)
    ctx = verify_user_context(token, SECRET)
    assert ctx and (ctx.user_id, ctx.search_id, ctx.execution_id) == ("u1", "s1", "e1")
    _body, sig = token.split(".")
    forged = sign_user_context("attacker", "s1", "e1", now + 60, "x" * 40).split(".")[0] + "." + sig
    assert verify_user_context(forged, SECRET) is None
    assert verify_user_context(token, "y" * 40) is None
    assert verify_user_context(sign_user_context("u1", "s1", "e1", now - 1, SECRET), SECRET) is None
    assert verify_user_context("garbage", SECRET) is None


async def test_start_refuses_mismatched_or_foreign_contexts(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    from app.services.execution_service import UserContextError

    svc = make_service(ScriptedLlm(intent_dict()))
    other = Ids(backend)
    with pytest.raises(UserContextError):
        await svc.start(ids.request("acme nova", user_context=other.context()))  # context for another search
    with pytest.raises(UserContextError):
        await svc.start(ids.request("acme nova", user_context=ids.context(exp_in=-5)))
    # Valid signature but the search belongs to someone else → backend 404 → nothing runs.
    ex = await run_to_end(svc, ids.request("acme nova", user_context=ids.context(user="intruder")))
    assert (ex.status, ex.persisted) == ("FAILED", False)
    assert not backend.calls_to("/sources/eligible")
    assert ids.search not in backend.saved


# ── 17. internal API authentication ─────────────────────────────────────


async def test_internal_api_requires_the_service_token(backend: FakeBackend, ids: Ids) -> None:
    app = create_app(
        settings(),
        llm=ScriptedLlm(intent_dict(), {"summary": "Three offers found."}),
        internal_api=api_for(backend),
        use_read_models=False,
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://agent") as client:
            body = ids.request("acme nova").model_dump()
            assert (await client.post("/internal/agent/search", json=body)).status_code == 401
            bad = {"authorization": "Bearer " + "w" * 40}
            assert (await client.post("/internal/agent/search", json=body, headers=bad)).status_code == 401
            assert (
                await client.get(f"/internal/agent/search/{ids.execution}", headers=bad)
            ).status_code == 401
            assert (await client.get("/health")).json()["status"] == "ok"
            good = {"authorization": f"Bearer {TOKEN}"}
            started = await client.post("/internal/agent/search", json=body, headers=good)
            assert started.status_code == 202
            for _ in range(100):
                status = (await client.get(f"/internal/agent/search/{ids.execution}", headers=good)).json()
                if status["status"] not in ("QUEUED", "RUNNING"):
                    break
                await asyncio.sleep(0.02)
            assert (status["status"], status["persisted"]) == ("COMPLETED", True)
            tampered = {**body, "user_context": ids.context(secret="z" * 40)}
            assert (
                await client.post("/internal/agent/search", json=tampered, headers=good)
            ).status_code == 403
            assert (
                await client.post("/internal/agent/search/not-an-id/cancel", headers=good)
            ).status_code == 422


# ── 18. provider failures at execution level ────────────────────────────


async def test_llm_outage_fails_unpersisted_for_retry(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    ex = await run_to_end(
        make_service(ScriptedLlm(LlmError("503 overloaded", provider="google"))), ids.request("acme nova")
    )
    assert (ex.status, ex.persisted) == ("FAILED", False)
    assert "AI provider unavailable" in (ex.error or "")
    assert not backend.calls_to("/marketplace/search") and ids.search not in backend.saved


async def test_llm_config_error_fails_and_is_persisted(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    llm = ScriptedLlm(LlmError("invalid API key", provider="google", retryable=False))
    ex = await run_to_end(make_service(llm), ids.request("acme nova"))
    assert (ex.status, ex.persisted) == ("FAILED", True)
    saved = backend.saved[ids.search][-1]
    assert saved["rankedDeals"] == [] and "could not be run" in saved["response"]


# ── response grounding ──────────────────────────────────────────────────


def test_narration_with_invented_figures_or_urls_is_rejected() -> None:
    deals = [
        {
            "rank": 1,
            "offer": {
                "productName": "Acme Nova 7",
                "sourceName": "Mock Alpha",
                "stockStatus": "IN_STOCK",
                "isSample": True,
                "pricing": {
                    "prices": {"deliveredPaise": 2_949_900},
                    "directDiscount": {"status": "OK", "mrpPaise": 3_834_870, "percentBp": 2307},
                    "assessment": {"verdict": "INSUFFICIENT_HISTORY", "genuineDiscountBp": 0},
                    "history": {"lowestClaim": {"kind": "NONE", "text": None}},
                },
            },
        }
    ]
    facts = facts_for(deals, "COMPLETED", [])
    assert format_rupees(2_949_900) == "₹29,499"
    assert validate_narration("Best: Acme Nova 7 at ₹29,499 (23.07% off).", facts) is None
    assert validate_narration("Best: Acme Nova 7 at ₹27,000.", facts) == "unsupported figure '₹27,000'"
    assert validate_narration("Buy at https://evil.example", facts) == "contains a URL"
    text = template_summary(facts, None)
    assert "₹29,499" in text and "sample/mock" in text and "not enough price history" in text
