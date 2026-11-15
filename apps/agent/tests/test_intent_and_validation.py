"""1. Intent extraction · 2. Pydantic validation · 3. Query validation · 18. LLM provider failures."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage
from pydantic import ValidationError

from app.nodes.query_validator import query_validator
from app.providers.base import LlmError
from app.providers.fallback import FallbackLlm
from app.providers.langchain_provider import LangChainStructuredLlm
from app.providers.rules import extract_intent_by_rules
from app.schemas.api import StartSearchRequest
from app.schemas.intent import ExtractedIntent
from app.utils.money import extract_rupee_amounts, is_stated, parse_budget
from tests.conftest import deps_for
from tests.fakes import FakeBackend, ScriptedLlm


class FakeStructuredChat:
    """Minimal chat model exposing with_structured_output (like LangChain models)."""

    def __init__(self, outputs: list[Any]) -> None:
        self.outputs = outputs
        self.calls = 0

    def with_structured_output(self, schema: Any, include_raw: bool = False) -> FakeStructuredChat:
        assert include_raw
        return self

    async def ainvoke(self, messages: Any, config: Any = None) -> Any:
        self.calls += 1
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


def intent(**over: Any) -> ExtractedIntent:
    return ExtractedIntent(**{"search_keywords": "smartphone", **over})


# ── 1. intent extraction ────────────────────────────────────────────────


async def test_langchain_provider_returns_validated_structured_output_with_token_usage() -> None:
    raw = AIMessage(
        content="", usage_metadata={"input_tokens": 310, "output_tokens": 55, "total_tokens": 365}
    )
    parsed = intent(category="smartphones", max_price_rupees=35_000, sort_mode="best_value")
    chat = FakeStructuredChat([{"raw": raw, "parsed": parsed, "parsing_error": None}])
    llm = LangChainStructuredLlm(chat, provider="google", model="configured-model")
    result = await llm.generate(ExtractedIntent, "sys", "user", name="intent_extractor")
    assert result.data.max_price_rupees == 35_000
    assert (result.usage.input_tokens, result.usage.output_tokens) == (310, 55)
    assert (result.provider, result.model) == ("google", "configured-model")


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        (
            "Find a newly launched smartphone under ₹35,000 with 8GB RAM and 256GB storage.",
            {"category": "smartphones", "max_price_rupees": 35_000, "launch_preference": "recently_launched"},
        ),
        (
            "Find the highest genuine discount on Samsung smartphones.",
            {"brands": ["samsung"], "sort_mode": "highest_discount", "genuine_discount_only": True},
        ),
        (
            "Compare the same laptop across Amazon and Flipkart",
            {"category": "laptops", "marketplaces": ["amazon_in", "flipkart"], "compare_same_product": True},
        ),
        ("Find the cheapest 1.5-ton inverter AC.", {"category": "air-conditioners", "sort_mode": "cheapest"}),
        (
            "Find the best-value washing machine under ₹25,000.",
            {"category": "washing-machines", "max_price_rupees": 25_000},
        ),
    ],
)
def test_rule_based_extraction_of_the_example_queries(query: str, expected: dict[str, Any]) -> None:
    got = extract_intent_by_rules(query).model_dump()
    for key, value in expected.items():
        assert got[key] == value, key


async def test_rule_provider_ignores_the_prompt_wrapper() -> None:
    from app.prompts.intent import INTENT_SYSTEM, intent_user_prompt
    from app.providers.rules import RuleBasedLlm

    result = await RuleBasedLlm().generate(
        ExtractedIntent,
        INTENT_SYSTEM,
        intent_user_prompt("Acme Nova 5G phone under 21k"),
        name="intent_extractor",
    )
    assert "user request" not in result.data.search_keywords
    assert result.data.search_keywords.startswith("acme nova 5g phone")
    assert result.data.max_price_rupees == 21_000


def test_rule_based_specs_and_exclusions() -> None:
    i = extract_intent_by_rules("8GB RAM 256GB storage phone, not samsung, 1.5 ton")
    names = {(s.name, s.value) for s in i.required_specifications}
    assert {("ram", "8GB"), ("storage", "256GB"), ("capacity", "1.5 ton")} <= names
    assert i.excluded_brands == ["samsung"]
    assert "samsung" not in i.brands


def test_rupee_amounts_are_only_money() -> None:
    q = "phone under ₹35,000 with 8GB RAM, 1.5 ton AC below 40k, budget 1.2 lakh, 55 inch"
    assert [a.rupees for a in extract_rupee_amounts(q)] == [35_000, 40_000, 120_000]
    assert parse_budget("between 20000 and 30000") == (20_000, 30_000)
    assert parse_budget("above ₹50,000") == (50_000, None)
    assert parse_budget("8GB RAM phone") == (None, None)
    assert is_stated(35_000, q) and not is_stated(30_000, q)


# ── 2. Pydantic validation ──────────────────────────────────────────────


def test_invalid_llm_output_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ExtractedIntent.model_validate({"search_keywords": "x" * 2, "max_price_rupees": -5})
    with pytest.raises(ValidationError):
        ExtractedIntent.model_validate({"search_keywords": "phone", "prices": {"amazon": 100}})  # unknown key
    with pytest.raises(ValidationError):
        ExtractedIntent.model_validate({"search_keywords": "phone", "sort_mode": "by_vibes"})


async def test_provider_retries_unparseable_output_then_fails_with_llm_error() -> None:
    bad = {"raw": AIMessage(content=""), "parsed": None, "parsing_error": "not json"}
    chat = FakeStructuredChat([bad, bad, bad])
    llm = LangChainStructuredLlm(chat, provider="openai", model="m", max_retries=2, base_delay_seconds=0)
    with pytest.raises(LlmError, match="no valid structured output"):
        await llm.generate(ExtractedIntent, "s", "u", name="intent_extractor")
    assert chat.calls == 3


def test_api_request_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        StartSearchRequest.model_validate(
            {
                "execution_id": "0" * 36,
                "search_id": "0" * 36,
                "user_context": "x" * 30,
                "query": "phone",
                "user_id": "spoof",
            }
        )


# ── 3. query validation ─────────────────────────────────────────────────


def _state(query: str, intent_obj: ExtractedIntent, explicit: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "original_query": query,
        "intent": intent_obj.model_dump(),
        "explicit_filters": explicit or {},
        "execution_id": "e",
    }


async def test_budget_the_user_did_not_state_is_dropped_never_adjusted(backend: FakeBackend) -> None:
    deps = deps_for(backend, ScriptedLlm())
    out = await query_validator(
        _state("phone with 8GB RAM", intent(max_price_rupees=30_000, category="smartphones")),  # type: ignore[arg-type]
        deps,
    )
    assert out["filters"]["max_price_paise"] is None
    assert "does not state" in out["warnings"][0]
    stated = await query_validator(
        _state("phone under ₹35,000", intent(max_price_rupees=35_000, category="smartphones")),  # type: ignore[arg-type]
        deps,
    )
    assert stated["filters"]["max_price_paise"] == 3_500_000


async def test_explicit_filters_win_and_specs_are_canonicalized(backend: FakeBackend) -> None:
    deps = deps_for(backend, ScriptedLlm())
    i = intent(
        category="smartphones",
        required_specifications=[{"name": "ram", "value": "8GB"}],
        max_price_rupees=35_000,
    )
    out = await query_validator(_state("phone under 35k 8GB RAM", i, {"maxPricePaise": 2_000_000}), deps)  # type: ignore[arg-type]
    assert out["filters"]["max_price_paise"] == 2_000_000
    assert out["filters"]["required_specs"] == {"ram_gb": 8}
    assert out["filters"]["category_slug"] == "smartphones"


@pytest.mark.parametrize(
    ("query", "fields", "fragment"),
    [
        (
            "phone above ₹50,000 under ₹20,000",
            {"min_price_rupees": 50_000, "max_price_rupees": 20_000},
            "minimum price",
        ),
        (
            "samsung phone not samsung",
            {"brands": ["Samsung"], "excluded_brands": ["Samsung"]},
            "both required and excluded",
        ),
        (
            "8GB RAM phone without 8GB RAM",
            {
                "required_specifications": [{"name": "ram", "value": "8GB"}],
                "excluded_specifications": [{"name": "ram", "value": "8GB"}],
            },
            "both required and excluded",
        ),
    ],
)
async def test_contradictions_ask_for_clarification(
    backend: FakeBackend, query: str, fields: dict[str, Any], fragment: str
) -> None:
    out = await query_validator(
        _state(query, intent(category="smartphones", **fields)), deps_for(backend, ScriptedLlm())
    )  # type: ignore[arg-type]
    assert out["next_action"] == "clarify"
    assert out["search_status"] == "NEEDS_CLARIFICATION"
    assert fragment in out["clarification_question"]


async def test_vague_queries_get_one_question_clear_ones_do_not(backend: FakeBackend) -> None:
    deps = deps_for(backend, ScriptedLlm())
    vague = await query_validator(_state("find a deal", intent(search_keywords="deal")), deps)  # type: ignore[arg-type]
    assert vague["next_action"] == "clarify"
    clear = await query_validator(
        _state("acme nova phone", intent(search_keywords="acme nova", category="smartphones")), deps
    )  # type: ignore[arg-type]
    assert clear["next_action"] == "plan"


# ── 18. provider failures ───────────────────────────────────────────────


async def test_fallback_is_used_only_when_configured() -> None:
    primary = ScriptedLlm(LlmError("quota", provider="google"), provider="google")
    fallback = ScriptedLlm(intent(category="smartphones"), provider="openai")
    result = await FallbackLlm(primary, fallback).generate(ExtractedIntent, "s", "u", name="intent_extractor")
    assert result.used_fallback and result.provider == "openai"
    with pytest.raises(LlmError):
        await ScriptedLlm(LlmError("quota", provider="google")).generate(ExtractedIntent, "s", "u", name="x")


async def test_auth_errors_are_not_retried() -> None:
    chat = FakeStructuredChat([PermissionError("401 Unauthorized: invalid API key")])
    llm = LangChainStructuredLlm(chat, provider="google", model="m", max_retries=3, base_delay_seconds=0)
    with pytest.raises(LlmError) as err:
        await llm.generate(ExtractedIntent, "s", "u", name="intent_extractor")
    assert chat.calls == 1 and err.value.retryable is False
