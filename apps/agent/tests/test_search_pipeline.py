"""4. Planning · 5. Source discovery · 6. Parallel search · 7. Partial failures ·
8. Normalization · 9. Deduplication · 10. Filters · 11. Pricing · 12. Ranking."""

from __future__ import annotations

from typing import Any

from app.clients.marketplace_api import MarketplaceApiClient
from app.nodes.apply_filters import check_offer
from app.nodes.calculate_discounts import calculate_discounts
from app.nodes.search_planner import build_plan
from app.schemas.intent import ShoppingFilters
from app.schemas.internal import MarketplaceRequest
from tests.conftest import Ids, api_for, run_to_end
from tests.fakes import FakeBackend, ScriptedLlm, item


def filters(**over: Any) -> ShoppingFilters:
    return ShoppingFilters(**{"keywords": "acme nova", **over})


def intent_dict(**over: Any) -> dict[str, Any]:
    return {"search_keywords": "acme nova", "category": "smartphones", **over}


# ── 4. planning ─────────────────────────────────────────────────────────


def test_plan_goes_from_precise_to_broad_and_adapts_depth() -> None:
    plan = build_plan(
        filters(required_specs={"ram_gb": 8, "storage_gb": 256}, brands=["Acme"], product_type="smartphone"),
        3,
    )
    assert plan.queries[0] == "acme nova 8GB RAM 256GB"
    assert plan.queries[1:] == ["Acme smartphone", "smartphone"]
    assert (plan.depth, plan.limit_per_source) == ("standard", 20)
    deep = build_plan(filters(sort_mode="highest_discount"), 3)
    assert (deep.depth, deep.limit_per_source) == ("deep", 40)
    assert build_plan(filters(compare_same_product=True), 3).min_results == 2


# ── 5/6/7. discovery, parallel search, partial failures ─────────────────


async def test_bounded_parallel_search_with_partial_failure(backend: FakeBackend) -> None:
    backend.sources = {
        f"s{i}": {"items": [item(f"s{i}", "x", "Acme Nova 7", "Acme", 100)], "delay": 0.05} for i in range(5)
    }
    backend.sources["s3"]["fail"] = 503
    client = MarketplaceApiClient(api_for(backend, max_retries=0), concurrency=2)
    result = await client.search_many(
        MarketplaceRequest(query="acme nova"), list(backend.sources), correlation_id="c"
    )
    assert backend.peak_in_flight == 2  # bounded
    statuses = {r.source_id: r.status for r in result.sources}
    assert statuses == {
        "s0": "SUCCEEDED",
        "s1": "SUCCEEDED",
        "s2": "SUCCEEDED",
        "s3": "FAILED",
        "s4": "SUCCEEDED",
    }
    assert {i.sourceId for i in result.items} == {"s0", "s1", "s2", "s4"}  # others kept
    assert next(r for r in result.sources if r.source_id == "s3").error_code == "INTERNAL_API_ERROR"


async def test_internal_api_retries_transient_errors(backend: FakeBackend) -> None:
    backend.fail_paths["/marketplace/search"] = 503  # first call only
    client = MarketplaceApiClient(api_for(backend, max_retries=2), concurrency=1)
    result = await client.search_many(MarketplaceRequest(query="acme"), ["mock_alpha"], correlation_id="c")
    assert result.sources[0].status == "SUCCEEDED"
    assert len(backend.calls_to("/marketplace/search")) == 2


async def test_full_search_end_to_end_partial(backend: FakeBackend, ids: Ids, make_service: Any) -> None:
    backend.sources["broken"] = {"items": [], "fail": 500}
    backend.skipped = [
        {
            "sourceId": "flipkart",
            "name": "Flipkart",
            "reason": "SOURCE_NOT_ACTIVE",
            "detail": "PENDING_CREDENTIALS",
        }
    ]
    llm = ScriptedLlm(intent_dict(), {"summary": "Two stores searched; one failed."})
    ex = await run_to_end(make_service(llm), ids.request("acme nova phone"))
    assert (ex.status, ex.persisted) == ("PARTIAL", True)
    saved = backend.saved[ids.search][-1]
    runs = {r["sourceId"]: r["status"] for r in saved["sourceRuns"]}
    assert runs == {
        "mock_alpha": "SUCCEEDED",
        "mock_beta": "SUCCEEDED",
        "broken": "FAILED",
        "flipkart": "SKIPPED",
    }
    assert len(saved["rankedDeals"]) == 3  # the three Acme Nova offers
    # The agent sends offer ids only: no prices, URLs or sellers in persisted results.
    for d in saved["rankedDeals"]:
        assert set(d) == {"offerId", "rank", "score", "explanation"}
    # Source discovery used the registry response, not a hardcoded list.
    assert backend.calls_to("/sources/eligible")


async def test_no_eligible_sources_completes_honestly_without_results(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    backend.sources = {}
    backend.skipped = [
        {
            "sourceId": "amazon_in",
            "name": "Amazon India",
            "reason": "SOURCE_NOT_ACTIVE",
            "detail": "PENDING_APPROVAL",
        }
    ]
    ex = await run_to_end(make_service(ScriptedLlm(intent_dict())), ids.request("acme nova phone"))
    saved = backend.saved[ids.search][-1]
    assert (ex.status, saved["status"], saved["rankedDeals"]) == ("COMPLETED", "COMPLETED", [])
    assert "Amazon India" in saved["response"]
    assert not backend.calls_to("/marketplace/search")


async def test_user_excluded_marketplace_is_not_searched(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    ex = await run_to_end(
        make_service(
            ScriptedLlm(intent_dict(excluded_marketplaces=["mock_beta"]), {"summary": "ok fine results"})
        ),
        ids.request("acme nova phone"),
    )
    assert ex.persisted
    searched = {b["only"][0] for b in backend.calls_to("/marketplace/search")}
    assert searched == {"mock_alpha"}


# ── 8/9. normalization and deduplication integration ───────────────────


async def test_items_are_sent_unchanged_to_normalization_and_dedup(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    backend.review_external_ids = {"b1"}
    await run_to_end(
        make_service(ScriptedLlm(intent_dict(), {"summary": "fine results here"})), ids.request("acme nova")
    )
    sent = backend.calls_to("/intelligence/normalize")[0]["items"]
    original = {(i["sourceId"], i["externalId"]): i for s in backend.sources.values() for i in s["items"]}
    for it in sent:
        assert it == original[(it["sourceId"], it["externalId"])]  # verbatim round-trip
    assert backend.calls_to("/intelligence/deduplicate")
    saved = backend.saved[ids.search][-1]
    assert any("held for review" in w for w in saved["warnings"])
    assert len(saved["rankedDeals"]) == 2  # the review item is not presented as a result


# ── 10. filters ─────────────────────────────────────────────────────────


def test_hard_filters_are_deterministic_and_never_relaxed() -> None:
    it = item("s", "1", "Acme Nova 7 (8GB RAM, 256GB Storage)", "Acme", 30_999, shippingPaise=4_000)
    f = filters(max_price_paise=3_103_900, required_specs={"ram_gb": 8, "storage_gb": 256})
    attrs = {"ram_gb": 8, "storage_gb": 256}
    assert check_offer(it, attrs, "Acme", f) is None
    assert (
        check_offer(it, attrs, "Acme", filters(max_price_paise=3_103_900 - 1)) == "above_max_price"
    )  # shipping counts
    assert check_offer(it, {"ram_gb": 8}, "Acme", f) == "spec_not_stated"
    assert check_offer(it, {"ram_gb": 12, "storage_gb": 256}, "Acme", f) == "spec_mismatch"
    assert check_offer(it, attrs, "Acme", filters(brands=["Zenith"])) == "brand_not_requested"
    assert check_offer(it, attrs, "Acme", filters(excluded_brands=["ACME"])) == "brand_excluded"
    assert check_offer(it, attrs, "Acme", filters(excluded_specs={"storage_gb": 256})) == "spec_excluded"


async def test_spec_filter_end_to_end(backend: FakeBackend, ids: Ids, make_service: Any) -> None:
    i = intent_dict(required_specifications=[{"name": "storage", "value": "256GB"}])
    await run_to_end(
        make_service(ScriptedLlm(i, {"summary": "nice fine results"})), ids.request("acme nova 256GB storage")
    )
    saved = backend.saved[ids.search][-1]
    titles = [backend.offers[d["offerId"]]["title"] for d in saved["rankedDeals"]]
    assert titles and all("256GB" in t for t in titles)
    assert saved["agentRun"]["metadata"]["filterReport"]["removed"]["spec_mismatch"] == 1


# ── 11/12. pricing and ranking integration ──────────────────────────────


async def test_genuine_discount_requirement_uses_the_pricing_engine(backend: FakeBackend) -> None:
    from tests.conftest import deps_for

    deps = deps_for(backend, ScriptedLlm())
    backend._intelligence_deduplicate({"items": backend.sources["mock_alpha"]["items"]})
    ids_ = list(backend.offers)
    backend.verdicts[ids_[0]] = "GENUINE"
    state: dict[str, Any] = {
        "filters": filters(genuine_discount_only=True).model_dump(),
        "candidate_offer_ids": ids_,
        "execution_id": "e",
        "filter_report": {},
    }
    out = await calculate_discounts(state, deps)  # type: ignore[arg-type]
    assert out["candidate_offer_ids"] == [ids_[0]]
    assert out["filter_report"]["removed"] == {"discount_insufficient_history": 2}


async def test_ranking_order_comes_from_the_ranking_engine(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    await run_to_end(
        make_service(ScriptedLlm(intent_dict(sort_mode="cheapest"), {"summary": "fine cheap results"})),
        ids.request("acme nova"),
    )
    rank_call = backend.calls_to("/intelligence/rank")[-1]
    assert rank_call["mode"] == "cheapest"
    assert set(rank_call) == {"query", "mode", "offerIds"}  # ids only, no prices
    saved = backend.saved[ids.search][-1]
    prices = [backend.offers[d["offerId"]]["sellingPricePaise"] for d in saved["rankedDeals"]]
    assert prices == sorted(prices)
    assert [d["rank"] for d in saved["rankedDeals"]] == [1, 2, 3]
