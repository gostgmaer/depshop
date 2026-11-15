"""Phase 3.3 integration: the agent orchestrates, the TypeScript pricing and
ranking engines decide. Eligibility is passed only when the user stated it."""

from __future__ import annotations

from typing import Any

from app.clients.intelligence_api import IntelligenceApiClient
from app.nodes.rank_deals import hard_filters
from app.providers.rules import extract_intent_by_rules
from app.schemas.intent import ShoppingFilters
from tests.conftest import Ids, api_for, run_to_end
from tests.fakes import FakeBackend, ScriptedLlm, item


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


async def test_explicit_availability_launch_and_discount_filters_are_hard(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    from datetime import UTC, datetime, timedelta

    recent = (datetime.now(UTC) - timedelta(days=20)).isoformat().replace("+00:00", "Z")
    old = (datetime.now(UTC) - timedelta(days=400)).isoformat().replace("+00:00", "Z")
    backend.launch_dates.update({"a1": recent, "a4": old, "b1": recent})
    backend.sources["mock_alpha"]["items"].append(
        item("mock_alpha", "a4", "Acme Nova 7 5G (12GB RAM, 512GB Storage)", "Acme", 36_999)
    )
    # b1 is a pre-order: its availability isn't confirmed.
    backend.sources["mock_beta"]["items"][0]["stockStatus"] = "PREORDER"
    service = make_service(ScriptedLlm(intent_dict(), {"summary": "Found acme results."}))
    req = ids.request(
        "acme nova",
        filters={"launchedWithinDays": 90, "inStockOnly": True, "minDiscountPercent": 10},
    )
    await run_to_end(service, req)
    rank_call = backend.calls_to("/intelligence/ranking/rank")[-1]
    kept = [backend.offers[i]["externalId"] for i in rank_call["offerIds"]]
    # a4 launched too long ago, a2 has no known launch date, b1 is a pre-order.
    assert kept == ["a1"]
    saved = backend.saved[ids.search][-1]
    assert any("launch date is unknown" in w for w in saved["warnings"]), saved["warnings"]


async def test_explicit_min_discount_overrides_the_ai(
    backend: FakeBackend, ids: Ids, make_service: Any
) -> None:
    service = make_service(ScriptedLlm(intent_dict(min_discount_percent=5), {"summary": "ok"}))
    # The fake engine reports a 23.07% direct discount for every offer with an MRP,
    # so the user's 30% minimum (not the AI's 5%) leaves nothing to rank.
    await run_to_end(service, ids.request("acme nova", filters={"minDiscountPercent": 30}))
    ranked = backend.calls_to("/intelligence/ranking/rank")
    assert not ranked or ranked[-1]["offerIds"] == []
