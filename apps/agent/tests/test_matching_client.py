"""The agent calls the TypeScript matching engine through the internal API.
It can read decisions, never resolve them (it holds no reviewer credential)."""

from __future__ import annotations

from typing import Any

import pytest

from app.clients.base import InternalApiError
from app.clients.intelligence_api import IntelligenceApiClient
from tests.conftest import api_for
from tests.fakes import FakeBackend

GTIN = "4006381333931"


def listing(title: str, **kw: Any) -> dict[str, Any]:
    return {
        "externalId": title.lower().replace(" ", "-"),
        "title": title,
        "productUrl": "https://mock-alpha.example.com/p/1",
        "brand": "Acme",
        "sellingPricePaise": 1_999_900,
        **kw,
    }


@pytest.fixture
def client(backend: FakeBackend) -> IntelligenceApiClient:
    backend.catalog_gtins[GTIN] = {
        "id": "01000000-0000-7000-8000-000000000009",
        "label": "Acme Nova 7",
        "brand": "Acme",
    }
    return IntelligenceApiClient(api_for(backend, max_retries=2))


async def test_match_returns_typed_decision_and_evidence(
    client: IntelligenceApiClient, backend: FakeBackend
) -> None:
    res = await client.match(listing("Acme Nova 7 5G", barcode=GTIN), correlation_id="c")
    assert res.decision == "AUTO_MERGE"
    assert res.method == "IDENTIFIER"
    assert res.confidence == "VERY_HIGH"
    assert res.product_b is not None and res.product_b.label == "Acme Nova 7"
    rec = await client.get_match(res.match_id, correlation_id="c")
    assert rec.decision == "AUTO_MERGE" and rec.review is None
    # The listing is forwarded unchanged.
    assert backend.calls_to("/intelligence/match") == [{"listing": listing("Acme Nova 7 5G", barcode=GTIN)}]


async def test_uncertain_match_is_queued_for_humans(client: IntelligenceApiClient) -> None:
    res = await client.match(listing("Acme Nova 7 Pro"), source_id="mock_alpha", correlation_id="c")
    assert res.decision == "MANUAL_REVIEW"
    assert res.review_id is not None
    rec = await client.get_match(res.match_id, correlation_id="c")
    assert rec.review == {"id": res.review_id, "status": "PENDING"}


async def test_unknown_match_is_not_found(client: IntelligenceApiClient) -> None:
    with pytest.raises(InternalApiError) as err:
        await client.get_match("02000000-0000-7000-8000-999999999999", correlation_id="c")
    assert err.value.status == 404


async def test_batch_chunks_at_100(client: IntelligenceApiClient, backend: FakeBackend) -> None:
    items = [{"listing": listing(f"Acme Thing {i}")} for i in range(150)]
    results = await client.match_batch(items, correlation_id="c")
    assert len(results) == 150
    assert [len(b["items"]) for b in backend.calls_to("/intelligence/match/batch")] == [100, 50]
    assert await client.match_batch([], correlation_id="c") == []


async def test_match_is_not_retried_because_it_appends_an_audit(
    client: IntelligenceApiClient, backend: FakeBackend
) -> None:
    backend.fail_paths["/intelligence/match"] = 503
    with pytest.raises(InternalApiError):
        await client.match(listing("Acme Nova 7"), correlation_id="c")
    assert len(backend.calls_to("/intelligence/match")) == 1


async def test_agent_has_no_way_to_resolve_a_review(
    client: IntelligenceApiClient, backend: FakeBackend
) -> None:
    assert not any("review" in name for name in dir(IntelligenceApiClient))
    res = await client.match(listing("Acme Nova 7 Pro"), source_id="mock_alpha", correlation_id="c")
    # Even a hand-rolled call with the service token is refused by the API.
    with pytest.raises(InternalApiError) as err:
        await api_for(backend, max_retries=0).request(
            "POST",
            f"/intelligence/matches/{res.match_id}/review",
            json={"resolution": {"action": "create"}},
            correlation_id="c",
            idempotent=False,
        )
    assert err.value.status == 403
