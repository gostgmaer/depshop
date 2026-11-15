"""DTOs of the Fastify internal API (/internal/v1). Field names follow the
TypeScript JSON (camelCase); validation happens on every response."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class MarketplaceRequest(CamelModel):
    """Connector request (mirrors shoppingSearchRequestSchema; strict on the TS side)."""

    query: str = Field(min_length=2, max_length=500)
    category: str | None = None
    brands: list[str] | None = None
    min_price_paise: int | None = Field(None, ge=0)
    max_price_paise: int | None = Field(None, ge=0)
    limit: int = Field(20, ge=1, le=50)

    def to_json(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True)


class EligibleSource(CamelModel):
    source_id: str
    name: str
    is_mock: bool
    capabilities: dict[str, Any]
    timeout_ms: int


class SkippedSource(CamelModel):
    source_id: str
    name: str
    reason: str
    detail: str | None = None


class Eligibility(CamelModel):
    eligible: list[EligibleSource]
    skipped: list[SkippedSource]


SourceRunStatus = Literal["SUCCEEDED", "FAILED", "TIMED_OUT", "SKIPPED"]


class SourceRun(CamelModel):
    source_id: str
    source_name: str = ""
    is_mock: bool = False
    status: SourceRunStatus
    result_count: int = 0
    rejected_items: int = 0
    duration_ms: int = 0
    attempts: int = 0
    cached: bool = False
    deduplicated: bool = False
    error_code: str | None = None
    error_message: str | None = None


class MarketplaceProduct(BaseModel):
    """A connector item exactly as the executor validated it. Extra fields are
    kept verbatim so it can be sent back to the TypeScript services unchanged."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    sourceId: str
    externalId: str
    title: str
    brand: str
    productUrl: str
    sellingPricePaise: int = Field(ge=0)
    priceType: Literal["LISTED", "VERIFIED_CHECKOUT", "INDICATIVE"]
    stockStatus: str
    currency: Literal["INR"]
    observedAt: str

    def wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class MarketplaceSearchResult(CamelModel):
    status: Literal["COMPLETED", "PARTIAL", "FAILED", "NO_SOURCES"]
    duration_ms: int
    sources: list[SourceRun]
    items: list[MarketplaceProduct]


class NormalizedItem(CamelModel):
    index: int
    ok: bool
    source_id: str
    external_id: str
    brand: str | None = None
    brand_key: str | None = None
    name: str | None = None
    normalized_name: str | None = None
    model_number: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    variant_key: str | None = None
    error: str | None = None


class DedupOutcome(CamelModel):
    index: int
    status: Literal["imported", "review", "rejected", "not_storable"]
    product_id: str | None = None
    variant_id: str | None = None
    offer_id: str | None = None
    method: str | None = None
    confidence: int | None = None
    reason: str | None = None


class VariantGroup(CamelModel):
    variant_id: str
    offer_ids: list[str]


class ProductGroup(CamelModel):
    product_id: str
    variants: list[VariantGroup]


class DedupResult(CamelModel):
    outcomes: list[DedupOutcome]
    groups: list[ProductGroup]


class Pricing(CamelModel):
    selling_price_paise: int
    effective_price_paise: int
    mrp_paise: int | None
    claimed_discount_bp: int
    claimed_savings_paise: int
    genuine_discount_bp: int
    verdict: Literal["GENUINE", "NOT_GENUINE", "INSUFFICIENT_HISTORY"]
    history: dict[str, Any]
    reasons: list[str]


class OfferFacts(CamelModel):
    """Facts about a stored offer, computed by the TypeScript services from the database."""

    offer_id: str
    product_id: str
    variant_id: str
    source_slug: str
    source_name: str
    is_sample: bool
    title: str
    product_name: str
    brand: str
    product_url: str
    seller_name: str | None
    stock_status: str
    launch_date: str | None
    variant_attributes: dict[str, Any]
    specifications: dict[str, Any]
    offer_conditions: dict[str, Any]
    observed_at: str
    pricing: Pricing


class RankedOffer(CamelModel):
    rank: int
    score: int
    breakdown: dict[str, int]
    offer: OfferFacts


class SearchRecord(CamelModel):
    id: str
    user_id: str
    query: str
    filters: dict[str, Any]
    status: str


class CategoryRef(CamelModel):
    slug: str
    name: str


# ── Product matching (deterministic TypeScript engine; humans resolve reviews) ──

MatchDecision = Literal["AUTO_MERGE", "MANUAL_REVIEW", "NEW_PRODUCT"]


class MatchProductRef(CamelModel):
    id: str | None = None
    label: str
    brand: str


class MatchCandidate(CamelModel):
    product_id: str | None = None
    label: str
    score: float
    decision: str


class MatchResult(CamelModel):
    """One listing vs the shared catalog: a dry run (the catalog is not changed).
    MANUAL_REVIEW means a human admin must decide; the agent never can."""

    match_id: str
    product_a: dict[str, Any]
    product_b: MatchProductRef | None = None
    score: float
    score_bp: int
    confidence: Literal["VERY_HIGH", "HIGH", "REVIEW", "LOW"]
    decision: MatchDecision
    method: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    conflicts: list[dict[str, Any]] = Field(default_factory=list)
    variant: dict[str, Any] | None = None
    candidates: list[MatchCandidate] = Field(default_factory=list)
    review_id: str | None = None
    deduplicated: bool = False


class MatchRecord(CamelModel):
    """Audit record of a match decision with its review status and resolutions."""

    id: str
    subject: str
    origin: str
    decision: str
    method: str
    score: float
    candidate_product_id: str | None = None
    result_product_id: str | None = None
    review: dict[str, Any] | None = None
    resolutions: list[dict[str, Any]] = Field(default_factory=list)
