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
    NormalizedItem,
    OfferFacts,
    RankedOffer,
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

    async def pricing(self, offer_ids: list[str], *, correlation_id: str) -> list[OfferFacts]:
        if not offer_ids:
            return []
        data = await self._api.request(
            "POST", "/intelligence/pricing", json={"offerIds": offer_ids}, correlation_id=correlation_id
        )
        return [OfferFacts.model_validate(o) for o in data["offers"]]

    async def rank(
        self, query: str, mode: SortMode, offer_ids: list[str], *, correlation_id: str
    ) -> list[RankedOffer]:
        if not offer_ids:
            return []
        data = await self._api.request(
            "POST",
            "/intelligence/rank",
            json={"query": query, "mode": mode, "offerIds": offer_ids},
            correlation_id=correlation_id,
        )
        return [RankedOffer.model_validate(r) for r in data["ranked"]]

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
