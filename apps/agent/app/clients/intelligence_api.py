"""Typed client for the deterministic TypeScript intelligence services and for
user-owned record persistence. The agent references offers by id only; every
price, discount, match and rank is computed by the TypeScript side."""

from __future__ import annotations

from typing import Any

from app.clients.base import InternalApi
from app.schemas.intent import SortMode
from app.schemas.internal import (
    CategoryRef,
    DedupResult,
    MarketplaceProduct,
    MatchRecord,
    MatchResult,
    NormalizedItem,
    OfferFacts,
    RankingResult,
    SearchRecord,
)


class IntelligenceApiClient:
    def __init__(self, api: InternalApi) -> None:
        self._api = api

    async def categories(self, *, correlation_id: str) -> list[CategoryRef]:
        data = await self._api.request("GET", "/categories", correlation_id=correlation_id)
        return [CategoryRef.model_validate(c) for c in data["categories"]]

    async def canonical_specs(
        self, specs: list[dict[str, str]], *, correlation_id: str
    ) -> dict[str, str | float]:
        if not specs:
            return {}
        data = await self._api.request(
            "POST", "/intelligence/canonical-specs", json={"specs": specs}, correlation_id=correlation_id
        )
        return dict(data["attributes"])

    async def normalize(
        self, items: list[MarketplaceProduct], category: str | None, *, correlation_id: str
    ) -> list[NormalizedItem]:
        if not items:
            return []
        body: dict[str, Any] = {"items": [i.wire() for i in items]}
        if category:
            body["categorySlug"] = category
        data = await self._api.request(
            "POST", "/intelligence/normalize", json=body, correlation_id=correlation_id
        )
        return [NormalizedItem.model_validate(r) for r in data["results"]]

    async def deduplicate(
        self, items: list[MarketplaceProduct], category: str | None, *, correlation_id: str
    ) -> DedupResult:
        if not items:
            return DedupResult(outcomes=[], groups=[])
        body: dict[str, Any] = {"items": [i.wire() for i in items]}
        if category:
            body["categorySlug"] = category
        # Idempotent upsert on the TypeScript side (unique source + external id).
        data = await self._api.request(
            "POST", "/intelligence/deduplicate", json=body, correlation_id=correlation_id
        )
        return DedupResult.model_validate(data)

    async def pricing(
        self,
        offer_ids: list[str],
        *,
        eligibility: dict[str, list[str]] | None = None,
        correlation_id: str,
    ) -> list[OfferFacts]:
        """Authoritative pricing (TypeScript engine, database prices); chunked at 400."""
        out: list[OfferFacts] = []
        for start in range(0, len(offer_ids), 400):
            body: dict[str, Any] = {"offerIds": offer_ids[start : start + 400]}
            if eligibility:
                body["eligibility"] = eligibility
            data = await self._api.request(
                "POST", "/intelligence/pricing/batch", json=body, correlation_id=correlation_id
            )
            out.extend(OfferFacts.model_validate(o) for o in data["offers"])
        return out

    async def price_history(self, offer_id: str, *, days: int = 180, correlation_id: str) -> dict[str, Any]:
        data = await self._api.request(
            "GET", f"/intelligence/pricing/history/{offer_id}?days={days}", correlation_id=correlation_id
        )
        return dict(data)

    async def compare(
        self,
        offer_ids: list[str],
        *,
        eligibility: dict[str, list[str]] | None = None,
        correlation_id: str,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"offerIds": offer_ids}
        if eligibility:
            body["eligibility"] = eligibility
        data = await self._api.request(
            "POST", "/intelligence/ranking/compare", json=body, correlation_id=correlation_id
        )
        return dict(data)

    async def rank(
        self,
        query: str,
        mode: SortMode,
        offer_ids: list[str],
        *,
        filters: dict[str, Any] | None = None,
        eligibility: dict[str, list[str]] | None = None,
        price_basis: str | None = None,
        correlation_id: str,
    ) -> RankingResult | None:
        """Deterministic ranking (TypeScript). Ids, filters and user-stated eligibility only."""
        if not offer_ids:
            return None
        body: dict[str, Any] = {"query": query, "mode": mode, "offerIds": offer_ids[:400]}
        if filters:
            body["filters"] = filters
        if eligibility:
            body["eligibility"] = eligibility
        if price_basis:
            body["priceBasis"] = price_basis
        data = await self._api.request(
            "POST", "/intelligence/ranking/rank", json=body, correlation_id=correlation_id
        )
        return RankingResult.model_validate(data)

    # ── product matching (dry run; review decisions are for human admins only) ──
    # There is deliberately no review method: resolving a MANUAL_REVIEW needs a
    # reviewer context signed by the admin backend, which this service never has.

    async def match(
        self, listing: dict[str, Any], *, source_id: str | None = None, correlation_id: str
    ) -> MatchResult:
        body: dict[str, Any] = {"listing": listing}
        if source_id:
            body["sourceId"] = source_id
        # Not retried: every call appends an audit record (and may queue a review).
        data = await self._api.request(
            "POST", "/intelligence/match", json=body, correlation_id=correlation_id, idempotent=False
        )
        return MatchResult.model_validate(data)

    async def match_batch(self, items: list[dict[str, Any]], *, correlation_id: str) -> list[MatchResult]:
        """items: [{"listing": {...}, "sourceId"?: str}]; sent in chunks of 100."""
        out: list[MatchResult] = []
        for start in range(0, len(items), 100):
            data = await self._api.request(
                "POST",
                "/intelligence/match/batch",
                json={"items": items[start : start + 100]},
                correlation_id=correlation_id,
                idempotent=False,
            )
            out.extend(MatchResult.model_validate(r) for r in data["results"])
        return out

    async def get_match(self, match_id: str, *, correlation_id: str) -> MatchRecord:
        data = await self._api.request(
            "GET", f"/intelligence/matches/{match_id}", correlation_id=correlation_id
        )
        return MatchRecord.model_validate(data)

    # ── user-owned records (signed user context + ownership re-checked by Fastify) ──

    async def get_search(self, search_id: str, *, user_context: str, correlation_id: str) -> SearchRecord:
        data = await self._api.request(
            "GET", f"/searches/{search_id}", user_context=user_context, correlation_id=correlation_id
        )
        return SearchRecord.model_validate(data)

    async def post_event(
        self, search_id: str, event: dict[str, Any], *, user_context: str, correlation_id: str
    ) -> None:
        await self._api.request(
            "POST",
            f"/searches/{search_id}/events",
            json=event,
            user_context=user_context,
            correlation_id=correlation_id,
            idempotent=False,
            expect_json=False,
        )

    async def save_result(
        self, search_id: str, payload: dict[str, Any], *, user_context: str, correlation_id: str
    ) -> dict[str, Any]:
        # PUT is idempotent on the server (results replaced in one transaction).
        data = await self._api.request(
            "PUT",
            f"/searches/{search_id}/agent-result",
            json=payload,
            user_context=user_context,
            correlation_id=correlation_id,
        )
        return dict(data)
