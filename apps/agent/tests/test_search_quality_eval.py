"""Search-understanding quality gates (Prompt 24).

The labelled dataset (evals/search_queries.jsonl) is scored through the same
deterministic steps the query validator runs in production. The thresholds
are the measured results after the Prompt 24 fixes; a change that lowers
them must be an explicit decision, not an accident.
"""

from __future__ import annotations

import pytest

from app.evals.intent_eval import SEED_CATEGORIES, keywords_clean, load_cases, run, summarize
from app.nodes.query_validator import match_category
from app.providers.rules import category_from_text, extract_intent_by_rules
from app.schemas.intent import ExtractedIntent
from app.utils.money import parse_budget


async def test_dataset_is_valid_and_split() -> None:
    cases = load_cases()
    splits = {c["split"] for c in cases}
    assert splits == {"dev", "holdout"}
    assert len(cases) >= 60


async def test_rules_extractor_meets_measured_quality() -> None:
    results = await run(load_cases())
    holdout = summarize([r for r in results if r.split == "holdout"])
    overall = summarize(results)
    # Measured 2026-11-18: overall exact 0.9667, field 0.9967; holdout exact 0.95.
    assert overall["exact_match"] >= 0.96
    assert overall["field_accuracy"] >= 0.995
    assert holdout["exact_match"] >= 0.95
    assert overall["keywords_clean"] == 1.0


@pytest.mark.parametrize(
    ("text", "slug"),
    [
        ("headphones", "audio"),
        ("noise cancelling headphones", "audio"),
        ("earphones", "audio"),
        ("smartphones", "smartphones"),
        ("mobile phones", "smartphones"),
        ("soundbar for tv", "audio"),  # the product named first
        ("smart tv", "televisions"),
        ("split ac", "air-conditioners"),
        ("ac", "air-conditioners"),
        ("backpacks", None),  # contains "ac" — never an air conditioner
        ("space heaters", None),
        ("compare across all available marketplaces", None),
    ],
)
def test_category_words_match_whole_words_only(text: str, slug: str | None) -> None:
    assert category_from_text(text) == slug


@pytest.mark.parametrize(
    ("category", "slug"),
    [
        ("headphones", "audio"),
        ("earphones", "audio"),
        ("backpacks", None),
        ("Air Conditioners", "air-conditioners"),
    ],
)
def test_validator_maps_llm_category_on_whole_words(category: str, slug: str | None) -> None:
    """Production regression: an LLM category of 'headphones' used to filter to smartphones."""
    intent = ExtractedIntent(category=category, search_keywords="query words")
    assert match_category(intent, SEED_CATEGORIES) == slug


@pytest.mark.parametrize(
    ("query", "budget"),
    [
        ("phone 20k ke andar", (None, 20_000)),
        ("tv 40000 tak", (None, 40_000)),
        ("laptop 50k se zyada", (50_000, None)),
        ("phone with 8gb ram", (None, None)),
    ],
)
def test_hinglish_budget_direction(query: str, budget: tuple[int | None, int | None]) -> None:
    assert parse_budget(query) == budget


def test_keywords_have_no_budget_or_stray_punctuation() -> None:
    intent = extract_intent_by_rules("gaming laptop with RTX 4060 under 1.2 lakh.")
    assert keywords_clean(intent.search_keywords)
    assert "1.2" not in intent.search_keywords


def test_product_lines_name_their_brand_but_exclusions_win() -> None:
    assert "apple" in extract_intent_by_rules("latest iPhone with 256GB").brands
    assert extract_intent_by_rules("phone except apple, no iphone").brands == []
