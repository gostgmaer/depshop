"""Schemas at the AI boundary.

`ExtractedIntent` is what the LLM must return (structured output). Nullable
instead of optional, so strict structured-output modes accept it. Code then
turns it into deterministic `ShoppingFilters`; the model never decides prices,
matches or rankings.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SortMode = Literal[
    "best_value",
    "lowest_price",
    "highest_discount",
    "recently_launched",
    "price_drop",
    "trending_deals",
    "relevance",
    # Earlier names, still accepted (the ranking engine maps them).
    "cheapest",
    "newest",
]
CardType = Literal["CREDIT", "DEBIT"]
LaunchPreference = Literal["any", "recently_launched"]


class SpecRequirement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(
        min_length=1, max_length=40, description="e.g. 'ram', 'storage', 'capacity', 'screen size'"
    )
    value: str = Field(min_length=1, max_length=60, description="as stated, e.g. '8GB', '1.5 ton', '55 inch'")


class ExtractedIntent(BaseModel):
    """Structured interpretation of a shopping query. Only what the user said."""

    model_config = ConfigDict(extra="forbid")

    category: str | None = Field(
        None,
        max_length=100,
        description="Shopping category in plain words, e.g. 'smartphones', 'washing machines'",
    )
    product_type: str | None = Field(
        None, max_length=100, description="e.g. 'inverter AC', 'front-load washer'"
    )
    brands: list[str] = Field(default_factory=list, max_length=20, description="Brands the user asked for")
    excluded_brands: list[str] = Field(default_factory=list, max_length=20)
    model: str | None = Field(None, max_length=100, description="A specific model if named")
    min_price_rupees: int | None = Field(
        None, ge=0, le=1_000_000_000, description="ONLY if the user stated it"
    )
    max_price_rupees: int | None = Field(
        None, ge=0, le=1_000_000_000, description="ONLY if the user stated it"
    )
    required_specifications: list[SpecRequirement] = Field(default_factory=list, max_length=20)
    excluded_specifications: list[SpecRequirement] = Field(default_factory=list, max_length=20)
    preferred_features: list[str] = Field(default_factory=list, max_length=20, description="Nice-to-haves")
    launch_preference: LaunchPreference = "any"
    min_discount_percent: int | None = Field(None, ge=0, le=100)
    genuine_discount_only: bool = False
    sort_mode: SortMode = "best_value"
    marketplaces: list[str] = Field(
        default_factory=list, max_length=10, description="Marketplaces the user named"
    )
    excluded_marketplaces: list[str] = Field(default_factory=list, max_length=10)
    compare_same_product: bool = False
    payment_banks: list[str] = Field(
        default_factory=list, max_length=10, description="Banks the user said they hold cards/accounts with"
    )
    card_types: list[CardType] = Field(
        default_factory=list, max_length=2, description="Card types the user said they have"
    )
    memberships: list[str] = Field(
        default_factory=list, max_length=10, description="Shopping memberships the user said they have"
    )
    search_keywords: str = Field(
        min_length=2, max_length=200, description="Concise marketplace search keywords"
    )
    clarification_question: str | None = Field(
        None, max_length=300, description="Only if the request cannot be searched without more information"
    )

    @field_validator(
        "brands",
        "excluded_brands",
        "marketplaces",
        "excluded_marketplaces",
        "preferred_features",
        "payment_banks",
        "memberships",
    )
    @classmethod
    def _clean_list(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for item in v:
            s = " ".join(item.split())[:80]
            if s and s.lower() not in {x.lower() for x in out}:
                out.append(s)
        return out


class ShoppingFilters(BaseModel):
    """Deterministic filters derived from the intent (money in integer paise)."""

    model_config = ConfigDict(extra="forbid")

    category_slug: str | None = None
    product_type: str | None = None
    brands: list[str] = Field(default_factory=list)
    excluded_brands: list[str] = Field(default_factory=list)
    model: str | None = None
    min_price_paise: int | None = Field(None, ge=0)
    max_price_paise: int | None = Field(None, ge=0)
    required_specs: dict[str, str | float] = Field(default_factory=dict)
    """Canonical attribute keys (ram_gb, storage_gb, capacity_ton…) produced by the catalog normalizer."""
    excluded_specs: dict[str, str | float] = Field(default_factory=dict)
    preferred_features: list[str] = Field(default_factory=list)
    launch_preference: LaunchPreference = "any"
    min_discount_bp: int | None = Field(None, ge=0, le=10_000)
    genuine_discount_only: bool = False
    launched_within_days: int | None = Field(None, ge=1, le=3650)
    """Explicit launch window: products without a known launch date are excluded (unverifiable)."""
    in_stock_only: bool = False
    """Explicit: only offers whose availability is confirmed (in stock or limited)."""
    sort_mode: SortMode = "best_value"
    source_slugs: list[str] | None = None
    excluded_source_slugs: list[str] = Field(default_factory=list)
    compare_same_product: bool = False
    # User-stated eligibility for conditional offers. None = not stated (never assumed).
    user_banks: list[str] | None = None
    user_card_types: list[CardType] | None = None
    user_memberships: list[str] | None = None
    keywords: str = Field(min_length=2)


class SearchPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    queries: list[str] = Field(min_length=1, max_length=3, description="Precise first, broader later")
    category_slug: str | None = None
    limit_per_source: int = Field(ge=1, le=50)
    depth: Literal["standard", "deep"] = "standard"
    min_results: int = Field(ge=1)


class Validation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    contradictions: list[str] = Field(default_factory=list)
    clarification_question: str | None = None
    warnings: list[str] = Field(default_factory=list)
