"""Node 2: turn the AI's intent into validated, deterministic filters.

Never silently changes the user's requirements:
  - a budget the model reports must literally appear in the query, otherwise
    it is dropped (with a warning), never "adjusted";
  - explicit API filters always win over the AI;
  - contradictions produce a clarification question instead of a guess.
"""

from __future__ import annotations

import re
from typing import Any

from app.nodes.deps import AgentDeps
from app.providers.rules import CATEGORY_WORDS, MARKETPLACES
from app.schemas.intent import ExtractedIntent, ShoppingFilters, Validation
from app.schemas.internal import CategoryRef
from app.state.state import ShoppingSearchState
from app.utils.money import is_stated

_KEY = re.compile(r"[^a-z0-9]")


def brand_key(s: str) -> str:
    return _KEY.sub("", s.lower())


def match_category(intent: ExtractedIntent, categories: list[CategoryRef]) -> str | None:
    """Maps the AI's category words to a catalog slug (None → search all categories)."""
    by_slug = {c.slug: c for c in categories}
    texts = [t.lower() for t in (intent.category, intent.product_type) if t]
    for text in texts:
        norm = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
        for c in categories:
            if norm in (c.slug, c.slug.rstrip("s")) or text == c.name.lower():
                return c.slug
        for slug, words in CATEGORY_WORDS.items():
            if slug in by_slug and any(w.strip() in f" {text} " or w.strip() == text for w in words):
                return slug
    return None


def marketplace_slugs(names: list[str]) -> list[str]:
    out: list[str] = []
    for n in names:
        key = n.lower().strip()
        slug = MARKETPLACES.get(key) or next((v for k, v in MARKETPLACES.items() if k in key), None)
        slug = slug or re.sub(r"[^a-z0-9]+", "_", key).strip("_")
        if slug and slug not in out:
            out.append(slug)
    return out


async def query_validator(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    intent = ExtractedIntent.model_validate(state["intent"])
    explicit = state.get("explicit_filters") or {}
    query = state["original_query"]
    cid = state["execution_id"]
    warnings: list[str] = []
    contradictions: list[str] = []

    # Budget: grounded in the user's words (or explicit filters).
    min_paise = intent.min_price_rupees * 100 if intent.min_price_rupees is not None else None
    max_paise = intent.max_price_rupees * 100 if intent.max_price_rupees is not None else None
    for label, rupees in (("minimum", intent.min_price_rupees), ("maximum", intent.max_price_rupees)):
        if rupees is not None and not is_stated(rupees, query):
            warnings.append(f"Ignored a {label} budget of ₹{rupees:,} that the query does not state.")
            if label == "minimum":
                min_paise = None
            else:
                max_paise = None
    if isinstance(explicit.get("minPricePaise"), int):
        min_paise = int(explicit["minPricePaise"])
    if isinstance(explicit.get("maxPricePaise"), int):
        max_paise = int(explicit["maxPricePaise"])
    if min_paise is not None and max_paise is not None and min_paise > max_paise:
        contradictions.append("The minimum price is higher than the maximum price.")

    brands = list(explicit.get("brands") or intent.brands)
    excluded_brands = intent.excluded_brands
    both = {brand_key(b) for b in brands} & {brand_key(b) for b in excluded_brands}
    if both:
        contradictions.append(f"The same brand is both required and excluded: {', '.join(sorted(both))}.")

    required = await deps.intelligence.canonical_specs(
        [s.model_dump() for s in intent.required_specifications], correlation_id=cid
    )
    excluded = await deps.intelligence.canonical_specs(
        [s.model_dump() for s in intent.excluded_specifications], correlation_id=cid
    )
    for key, value in required.items():
        if key in excluded and str(excluded[key]).lower() == str(value).lower():
            contradictions.append(f"'{key}' = {value} is both required and excluded.")

    categories = await deps.intelligence.categories(correlation_id=cid)
    category = explicit.get("category") if isinstance(explicit.get("category"), str) else None
    category = category or match_category(intent, categories)

    sources = explicit.get("sourceSlugs")
    source_slugs = (
        list(sources) if isinstance(sources, list) else (marketplace_slugs(intent.marketplaces) or None)
    )
    excluded_sources = marketplace_slugs(intent.excluded_marketplaces)
    if source_slugs and set(source_slugs) <= set(excluded_sources):
        contradictions.append("Every requested marketplace is also excluded.")

    filters = ShoppingFilters(
        category_slug=category,
        product_type=intent.product_type,
        brands=brands,
        excluded_brands=excluded_brands,
        model=intent.model,
        min_price_paise=min_paise,
        max_price_paise=max_paise,
        required_specs=required,
        excluded_specs=excluded,
        preferred_features=intent.preferred_features,
        launch_preference=intent.launch_preference,
        min_discount_bp=intent.min_discount_percent * 100
        if intent.min_discount_percent is not None
        else None,
        genuine_discount_only=intent.genuine_discount_only,
        sort_mode=intent.sort_mode,
        source_slugs=source_slugs,
        excluded_source_slugs=excluded_sources,
        compare_same_product=intent.compare_same_product,
        keywords=intent.search_keywords,
    )

    question: str | None = None
    if contradictions:
        question = (
            "Your request has conflicting requirements: " + " ".join(contradictions) + " Which should I use?"
        )
    elif intent.clarification_question:
        question = intent.clarification_question
    elif (
        not (category or intent.product_type or brands or intent.model)
        and len([w for w in re.findall(r"[a-z0-9]+", intent.search_keywords.lower()) if len(w) > 2]) < 2
    ):
        question = "What kind of product are you looking for?"

    validation = Validation(
        ok=question is None, contradictions=contradictions, clarification_question=question, warnings=warnings
    )
    update: dict[str, Any] = {
        "filters": filters.model_dump(),
        "validation": validation.model_dump(),
        "warnings": warnings,
        "next_action": "plan" if validation.ok else "clarify",
    }
    if not validation.ok:
        update["search_status"] = "NEEDS_CLARIFICATION"
        update["clarification_question"] = question
    return update
