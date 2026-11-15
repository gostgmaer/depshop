"""Phase 3.3 integration: the agent orchestrates, the TypeScript pricing and
ranking engines decide. Eligibility is passed only when the user stated it."""

from __future__ import annotations

from typing import Any

from app.clients.intelligence_api import IntelligenceApiClient
from app.nodes.rank_deals import hard_filters
from app.providers.rules import extract_intent_by_rules
from app.schemas.intent import ShoppingFilters
from tests.conftest import Ids, api_for, run_to_end
from tests.fakes import FakeBackend, ScriptedLlm


def intent_dict(**over: Any) -> dict[str, Any]:
    return {"search_keywords": "acme nova", "category": "smartphones", **over}


def test_rules_extract_only_stated_eligibility() -> None:
    i = extract_intent_by_rules("cheapest acme phone, I have an HDFC credit card and Flipkart Plus")
    assert i.payment_banks == ["HDFC"]
    assert i.card_types == ["CREDIT"]
    assert i.memberships == ["Flipkart Plus"]
    assert i.sort_mode == "lowest_price"
    none = extract_intent_by_rules("cheapest acme phone under 20000")
    assert (none.payment_banks, none.card_types, none.memberships) == ([], [], [])
    assert extract_intent_by_rules("acme phones with a recent price drop").sort_mode == "price_drop"


def test_hard_filters_are_passed_to_the_engine_unchanged() -> None:
    f = ShoppingFilters(
        keywords="acme",
        max_price_paise=2_000_000,
        brands=["Acme"],
        required_specs={"ram_gb": 8},
        excluded_source_slugs=["mock_beta"],
        category_slug="smartphones",
    )
    assert hard_filters(f) == {
        "maxPricePaise": 2_000_000,
        "brands": ["Acme"],
        "requiredSpecs": {"ram_gb": 8},
        "excludedSourceSlugs": ["mock_beta"],
        "categorySlugs": ["smartphones"],
    }


async def test_stated_eligibility_reaches_pricing_and_ranking(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    await run_to_end(
        make_service(
            ScriptedLlm(
                intent_dict(sort_mode="lowest_price", payment_banks=["HDFC"], card_types=["CREDIT"]),
                {"summary": "Found acme results."},
            )
        ),
        ids.request("acme nova with my HDFC credit card"),
    )
    eligibility = {"banks": ["HDFC"], "cardTypes": ["CREDIT"]}
    assert backend.calls_to("/intelligence/pricing/batch")[-1]["eligibility"] == eligibility
    rank_call = backend.calls_to("/intelligence/ranking/rank")[-1]
    assert rank_call["eligibility"] == eligibility
    assert rank_call["priceBasis"] == "best_verified"
    assert rank_call["filters"] == {"categorySlugs": ["smartphones"]}


async def test_trending_falls_back_with_a_user_warning(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    await run_to_end(
        make_service(
            ScriptedLlm(intent_dict(sort_mode="trending_deals"), {"summary": "Found acme results."})
        ),
        ids.request("trending acme deals"),
    )
    saved = backend.saved[ids.search][-1]
    assert "ranked as best_value instead" in saved["warnings"]


async def test_pricing_batches_are_chunked_and_carry_no_prices(backend: FakeBackend) -> None:
    client = IntelligenceApiClient(api_for(backend))
    ids_ = [f"00000000-0000-7000-8000-{i:012d}" for i in range(450)]
    assert await client.pricing(ids_, correlation_id="c") == []  # unknown ids → nothing invented
    calls = backend.calls_to("/intelligence/pricing/batch")
    assert [len(c["offerIds"]) for c in calls] == [400, 50]
    assert all(set(c) == {"offerIds"} for c in calls)
    assert await client.rank("q", "best_value", [], correlation_id="c") is None


async def test_ui_sort_mode_and_specs_are_explicit_overrides(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    service = make_service(
        ScriptedLlm(intent_dict(sort_mode="best_value"), {"summary": "Found acme results."})
    )
    req = ids.request(
        "acme nova", filters={"sortMode": "highest_discount", "specs": [{"name": "ram", "value": "8GB"}]}
    )
    await run_to_end(service, req)
    rank_call = backend.calls_to("/intelligence/ranking/rank")[-1]
    assert rank_call["mode"] == "highest_discount"
    assert rank_call["filters"]["requiredSpecs"] == {"ram_gb": 8}
