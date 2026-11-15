"""Typed client for the TypeScript marketplace connector framework.

The agent never implements connectors. It asks the Fastify internal API which
sources are eligible and fans out one call per source (bounded concurrency).
One source's failure becomes a FAILED run for that source; the others' results
are kept (partial results).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from app.clients.base import InternalApi, InternalApiError
from app.schemas.internal import (
    Eligibility,
    MarketplaceProduct,
    MarketplaceRequest,
    MarketplaceSearchResult,
    SourceRun,
)


@dataclass(slots=True)
class MultiSearchResult:
    sources: list[SourceRun] = field(default_factory=list)
    items: list[MarketplaceProduct] = field(default_factory=list)
    duration_ms: int = 0


class MarketplaceApiClient:
    def __init__(self, api: InternalApi, *, concurrency: int = 6) -> None:
        self._api = api
        self._concurrency = concurrency

    async def eligible_sources(
        self, request: MarketplaceRequest, *, only: list[str] | None, correlation_id: str
    ) -> Eligibility:
        body: dict[str, Any] = {"request": request.to_json()}
        if only is not None:
            body["only"] = only
        data = await self._api.request("POST", "/sources/eligible", json=body, correlation_id=correlation_id)
        return Eligibility.model_validate(data)

    async def source_status(self, source_id: str, *, correlation_id: str) -> dict[str, Any]:
        data = await self._api.request("GET", f"/sources/{source_id}", correlation_id=correlation_id)
        return dict(data)

    async def search_source(
        self, request: MarketplaceRequest, source_id: str, *, correlation_id: str
    ) -> MarketplaceSearchResult:
        data = await self._api.request(
            "POST",
            "/marketplace/search",
            json={"request": request.to_json(), "only": [source_id]},
            correlation_id=f"{correlation_id}:{source_id}",
        )
        return MarketplaceSearchResult.model_validate(data)

    async def search_many(
        self, request: MarketplaceRequest, source_ids: list[str], *, correlation_id: str
    ) -> MultiSearchResult:
        """Searches every source concurrently (bounded); never raises for one source."""
        started = time.monotonic()
        semaphore = asyncio.Semaphore(self._concurrency)

        async def one(source_id: str) -> tuple[str, MarketplaceSearchResult | InternalApiError, int]:
            async with semaphore:
                t0 = time.monotonic()
                try:
                    return (
                        source_id,
                        await self.search_source(request, source_id, correlation_id=correlation_id),
                        0,
                    )
                except InternalApiError as err:
                    return source_id, err, int((time.monotonic() - t0) * 1000)

        out = MultiSearchResult()
        for source_id, result, elapsed in await asyncio.gather(*(one(s) for s in source_ids)):
            if isinstance(result, InternalApiError):
                out.sources.append(
                    SourceRun(
                        source_id=source_id,
                        status="FAILED",
                        duration_ms=elapsed,
                        error_code="INTERNAL_API_ERROR",
                        error_message=str(result)[:500],
                    )
                )
                continue
            runs = [r for r in result.sources if r.source_id == source_id] or result.sources
            out.sources.extend(runs)
            out.items.extend(i for i in result.items if i.sourceId == source_id)
        out.duration_ms = int((time.monotonic() - started) * 1000)
        return out
