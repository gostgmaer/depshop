"""Test doubles.

FakeBackend: an in-memory stand-in for the Fastify internal API (/internal/v1)
behind an httpx.MockTransport. It mirrors the real contract (paths, camelCase
JSON, service auth, signed user context + ownership) and the deterministic
behaviour the agent relies on. Marketplace items are FICTIONAL test data.

ScriptedLlm: deterministic "LLM" responses (or failures) for tests.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel

from app.providers.base import LlmError, LlmResult, LlmUsage
from app.utils.user_context import verify_user_context

T = TypeVar("T", bound=BaseModel)
TOKEN = "t" * 40
SECRET = "s" * 40


def item(source: str, ext: str, title: str, brand: str, price_rupees: int, **extra: Any) -> dict[str, Any]:
    return {
        "sourceId": source,
        "externalId": ext,
        "title": title,
        "brand": brand,
        "productUrl": f"https://{source.replace('_', '-')}.example.com/p/{ext}",
        "sellingPricePaise": price_rupees * 100,
        "mrpPaise": int(price_rupees * 130),
        "priceType": "LISTED",
        "currency": "INR",
        "stockStatus": "IN_STOCK",
        "observedAt": "2026-11-15T10:00:00.000Z",
        "attributes": {},
        "variant": {"attributes": {}},
        "promotions": [],
        "provenance": {"method": "MOCK", "provider": "test", "retrievedAt": "2026-11-15T10:00:00.000Z"},
        **extra,
    }


def _base_title(title: str) -> str:
    return re.sub(r"\s*\(.*", "", title).strip()


def _attrs(title: str) -> dict[str, Any]:
    """Tiny stand-in for the catalog normalizer (RAM/storage/capacity)."""
    t = title.lower()
    out: dict[str, Any] = {}
    if m := re.search(r"(\d+)\s*gb\s*ram", t):
        out["ram_gb"] = int(m.group(1))
    if m := re.search(r"(\d+)\s*gb\s*(storage|rom|ssd)", t):
        out["storage_gb"] = int(m.group(1))
    if m := re.search(r"(\d+(?:\.\d+)?)\s*ton", t):
        out["capacity_ton"] = float(m.group(1))
    return out


@dataclass
class FakeBackend:
    sources: dict[str, dict[str, Any]] = field(default_factory=dict)
    """slug → {"items": [...], "fail": int|None (HTTP status), "delay": float, "mock": bool}"""
    skipped: list[dict[str, Any]] = field(default_factory=list)
    searches: dict[str, str] = field(default_factory=dict)  # search id → owner user id
    runs: dict[str, str] = field(default_factory=dict)  # execution id → search id
    verdicts: dict[str, str] = field(default_factory=dict)  # offer id → verdict
    review_external_ids: set[str] = field(default_factory=set)
    fail_paths: dict[str, int] = field(default_factory=dict)  # path prefix → status (once each)
    calls: list[tuple[str, str, Any]] = field(default_factory=list)
    saved: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    events: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    in_flight: int = 0
    peak_in_flight: int = 0
    offers: dict[str, dict[str, Any]] = field(default_factory=dict)
    matches: dict[str, dict[str, Any]] = field(default_factory=dict)
    ranking_tokens: list[str] = field(default_factory=list)
    catalog_gtins: dict[str, dict[str, Any]] = field(default_factory=dict)  # gtin → product ref

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def calls_to(self, path: str) -> list[Any]:
        return [body for (_m, p, body) in self.calls if p == path]

    # ── handler ──────────────────────────────────────────────────────────
    async def handle(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(
                401, json={"success": False, "error": {"code": "UNAUTHENTICATED", "message": "x"}}
            )
        path = request.url.path.removeprefix("/internal/v1")
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        for prefix, status in list(self.fail_paths.items()):
            if path.startswith(prefix):
                del self.fail_paths[prefix]
                return httpx.Response(
                    status, json={"success": False, "error": {"code": "X", "message": "boom"}}
                )
        if m := re.fullmatch(r"/intelligence/matches/([0-9a-f-]+)(/review)?", path):
            return self._match_record(request, m.group(1), m.group(2) is not None)
        if m := re.fullmatch(r"/searches/([0-9a-f-]+)(/.*)?", path):
            return self._private(request, m.group(1), m.group(2) or "", body)
        route = getattr(self, "_" + path.strip("/").replace("/", "_").replace("-", "_"), None)
        if route is None:
            return httpx.Response(
                404, json={"success": False, "error": {"code": "NOT_FOUND", "message": path}}
            )
        try:
            result = route(body)
            if asyncio.iscoroutine(result):
                result = await result
        except _HttpFailure as f:
            return httpx.Response(
                f.status, json={"success": False, "error": {"code": "UPSTREAM", "message": "down"}}
            )
        return httpx.Response(200, json=result)

    def _private(self, request: httpx.Request, search_id: str, sub: str, body: Any) -> httpx.Response:
        ctx = verify_user_context(request.headers.get("x-dealmind-user-context", ""), SECRET)
        if ctx is None or ctx.search_id != search_id:
            return httpx.Response(
                403, json={"success": False, "error": {"code": "FORBIDDEN", "message": "ctx"}}
            )
        if self.searches.get(search_id) != ctx.user_id:
            return httpx.Response(
                404, json={"success": False, "error": {"code": "NOT_FOUND", "message": "Search"}}
            )
        if sub == "":
            return httpx.Response(
                200,
                json={
                    "id": search_id,
                    "userId": ctx.user_id,
                    "query": "q",
                    "filters": {},
                    "status": "RUNNING",
                },
            )
        if sub == "/events":
            self.events.setdefault(search_id, []).append(body)
            return httpx.Response(204)
        if sub == "/agent-result":
            if self.runs.get(ctx.execution_id) != search_id:
                return httpx.Response(
                    404, json={"success": False, "error": {"code": "NOT_FOUND", "message": "Agent run"}}
                )
            unknown = [d["offerId"] for d in body["rankedDeals"] if d["offerId"] not in self.offers]
            if unknown:
                return httpx.Response(
                    422, json={"success": False, "error": {"code": "VALIDATION_ERROR", "message": "offers"}}
                )
            self.saved.setdefault(search_id, []).append(body)
            return httpx.Response(200, json={"saved": True})
        return httpx.Response(404)

    def _match_record(self, request: httpx.Request, match_id: str, review: bool) -> httpx.Response:
        if review:
            # Mirrors Fastify: the service token alone can never resolve a review.
            if not request.headers.get("x-dealmind-reviewer-context"):
                return httpx.Response(
                    403, json={"success": False, "error": {"code": "FORBIDDEN", "message": "reviewer"}}
                )
            return httpx.Response(500)
        rec = self.matches.get(match_id)
        if rec is None:
            return httpx.Response(
                404, json={"success": False, "error": {"code": "NOT_FOUND", "message": "Match"}}
            )
        return httpx.Response(
            200,
            json={
                "id": match_id,
                "subject": "LISTING",
                "origin": "INTERNAL_API",
                "decision": rec["decision"],
                "method": rec["method"],
                "score": rec["score"],
                "candidateProductId": (rec["productB"] or {}).get("id"),
                "review": {"id": rec["reviewId"], "status": "PENDING"} if rec["reviewId"] else None,
                "resolutions": [],
            },
        )

    def _match_one(self, req: dict[str, Any]) -> dict[str, Any]:
        listing = req["listing"]
        known = self.catalog_gtins.get(listing.get("barcode", ""))
        product_b: dict[str, Any] | None
        if known:
            decision, method, score, product_b = "AUTO_MERGE", "IDENTIFIER", 100.0, known
        elif "pro" in listing["title"].lower().split():
            decision, method, score = "MANUAL_REVIEW", "FUZZY_TITLE", 82.6
            product_b = {
                "id": "01000000-0000-7000-8000-000000000001",
                "label": "Acme Nova 7",
                "brand": "Acme",
            }
        else:
            decision, method, score, product_b = "NEW_PRODUCT", "NEW_PRODUCT", 0.0, None
        match_id = f"02000000-0000-7000-8000-{len(self.matches):012d}"
        queued = decision == "MANUAL_REVIEW" and req.get("sourceId")
        rec: dict[str, Any] = {
            "matchId": match_id,
            "productA": {"label": listing["title"], "brand": listing["brand"]},
            "productB": product_b,
            "score": score,
            "scoreBp": int(score * 100),
            "confidence": "VERY_HIGH" if score >= 98 else "REVIEW" if score >= 75 else "LOW",
            "decision": decision,
            "method": method,
            "evidence": {},
            "conflicts": [],
            "variant": None,
            "candidates": [],
            "reviewId": "03000000-0000-7000-8000-000000000001" if queued else None,
        }
        self.matches[match_id] = rec
        return rec

    def _intelligence_match(self, body: Any) -> dict[str, Any]:
        return self._match_one(body)

    def _intelligence_match_batch(self, body: Any) -> dict[str, Any]:
        return {"results": [self._match_one(i) for i in body["items"]]}

    # ── public routes (mirror /internal/v1) ──────────────────────────────
    def _categories(self, _body: Any) -> dict[str, Any]:
        return {
            "categories": [
                {"slug": s, "name": n}
                for s, n in [
                    ("smartphones", "Smartphones"),
                    ("laptops", "Laptops"),
                    ("air-conditioners", "Air Conditioners"),
                    ("washing-machines", "Washing Machines"),
                    ("televisions", "Televisions"),
                ]
            ]
        }

    def _intelligence_canonical_specs(self, body: Any) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for s in body["specs"]:
            text = f"{s['name']} {s['value']}".lower()
            if "ram" in text and (m := re.search(r"(\d+)", text)):
                out["ram_gb"] = int(m.group(1))
            elif "storage" in text and (m := re.search(r"(\d+)", text)):
                out["storage_gb"] = int(m.group(1))
            elif "ton" in text and (m := re.search(r"(\d+(?:\.\d+)?)", text)):
                out["capacity_ton"] = float(m.group(1))
            else:
                out[s["name"].lower()] = s["value"].lower()
        return {"attributes": out}

    def _sources_eligible(self, body: Any) -> dict[str, Any]:
        only = body.get("only")
        eligible = [
            {
                "sourceId": s,
                "name": s,
                "isMock": cfg.get("mock", True),
                "capabilities": {"search": True},
                "timeoutMs": 1000,
            }
            for s, cfg in self.sources.items()
            if only is None or s in only
        ]
        return {"eligible": eligible, "skipped": self.skipped}

    async def _marketplace_search(self, body: Any) -> Any:
        source = body["only"][0]
        cfg = self.sources[source]
        self.in_flight += 1
        self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        try:
            await asyncio.sleep(cfg.get("delay", 0))
            if cfg.get("fail"):
                raise _HttpFailure(cfg["fail"])
            q = body["request"]["query"].lower().split()
            items = [i for i in cfg["items"] if any(w in i["title"].lower() for w in q)]
            run = {
                "sourceId": source,
                "sourceName": source,
                "isMock": True,
                "status": "SUCCEEDED",
                "resultCount": len(items),
                "durationMs": 5,
                "attempts": 1,
            }
            return {
                "status": "COMPLETED",
                "durationMs": 5,
                "fingerprint": "f",
                "sources": [run],
                "items": items,
            }
        finally:
            self.in_flight -= 1

    def _intelligence_normalize(self, body: Any) -> dict[str, Any]:
        return {
            "results": [
                {
                    "index": i,
                    "ok": True,
                    "sourceId": it["sourceId"],
                    "externalId": it["externalId"],
                    "brand": it["brand"],
                    "brandKey": it["brand"].lower(),
                    "name": it["title"],
                    "normalizedName": it["title"].lower(),
                    "attributes": {**_attrs(it["title"]), **it.get("variant", {}).get("attributes", {})},
                    "variantKey": "k",
                }
                for i, it in enumerate(body["items"])
            ]
        }

    def _intelligence_deduplicate(self, body: Any) -> dict[str, Any]:
        outcomes: list[dict[str, Any]] = []
        groups: dict[str, dict[str, list[str]]] = {}
        for i, it in enumerate(body["items"]):
            if it["externalId"] in self.review_external_ids:
                outcomes.append({"index": i, "status": "review", "confidence": 8000})
                continue
            offer_id = (
                f"00000000-0000-7000-8000-{abs(hash((it['sourceId'], it['externalId']))) % 10**12:012d}"
            )
            product_id = f"10000000-0000-7000-8000-{abs(hash(_base_title(it['title']))) % 10**12:012d}"
            variant_id = f"20000000-0000-7000-8000-{abs(hash(it['title'])) % 10**12:012d}"
            self.offers[offer_id] = {
                **it,
                "offerId": offer_id,
                "productId": product_id,
                "variantId": variant_id,
            }
            outcomes.append(
                {
                    "index": i,
                    "status": "imported",
                    "productId": product_id,
                    "variantId": variant_id,
                    "offerId": offer_id,
                    "method": "NEW_PRODUCT",
                    "confidence": 10000,
                }
            )
            groups.setdefault(product_id, {}).setdefault(variant_id, []).append(offer_id)
        return {
            "outcomes": outcomes,
            "groups": [
                {"productId": p, "variants": [{"variantId": v, "offerIds": o} for v, o in vs.items()]}
                for p, vs in groups.items()
            ],
        }

    def _facts(self, offer_id: str) -> dict[str, Any]:
        o = self.offers[offer_id]
        verdict = self.verdicts.get(offer_id, "INSUFFICIENT_HISTORY")
        price = o["sellingPricePaise"]
        return {
            "offerId": offer_id,
            "productId": o["productId"],
            "variantId": o["variantId"],
            "sourceSlug": o["sourceId"],
            "sourceName": o["sourceId"].replace("_", " ").title(),
            "isSample": True,
            "title": o["title"],
            "productName": re.sub(r"\s*\(.*", "", o["title"]),
            "brand": o["brand"],
            "productUrl": o["productUrl"],
            "sellerName": None,
            "stockStatus": o["stockStatus"],
            "launchDate": o.get("launchDate"),
            "variantAttributes": {},
            "specifications": {},
            "offerConditions": {},
            "observedAt": o["observedAt"],
            "pricing": {
                "offerId": offer_id,
                "currency": "INR",
                "observedAt": o["observedAt"],
                "priceType": "LISTED",
                "stockStatus": o["stockStatus"],
                "directDiscount": {
                    "status": "OK" if o.get("mrpPaise") else "NO_MRP",
                    "mrpPaise": o.get("mrpPaise"),
                    "sellingPricePaise": price,
                    "amountPaise": (o["mrpPaise"] - price) if o.get("mrpPaise") else None,
                    "percentBp": 2307 if o.get("mrpPaise") else None,
                    "percentText": "23.07%" if o.get("mrpPaise") else None,
                },
                "pricingException": None,
                "prices": {
                    "basePaise": price,
                    "shippingPaise": 0,
                    "shippingKnown": True,
                    "mandatoryFeesPaise": 0,
                    "deliveredPaise": price,
                    "couponPricePaise": None,
                    "bankOfferPricePaise": None,
                    "membershipPricePaise": None,
                    "bestVerifiedPayablePaise": price,
                    "bestVerifiedPayableBasis": "DELIVERED",
                    "cashbackPaise": None,
                    "cashbackAdjustedReferencePaise": None,
                    "exchangeMaxBenefitPaise": None,
                },
                "benefits": [],
                "fees": [],
                "emi": [],
                "flags": [],
                "history": {
                    "lowestClaim": {"kind": "NONE", "days": None, "text": None},
                    "trend": "INSUFFICIENT_DATA",
                },
                "assessment": {
                    "verdict": verdict,
                    "genuineDiscountBp": 900 if verdict == "GENUINE" else 0,
                    "claimedDiscountBp": 2307,
                },
            },
        }

    def _intelligence_pricing_batch(self, body: Any) -> dict[str, Any]:
        offers = [self._facts(i) for i in body["offerIds"] if i in self.offers]
        return {"offers": offers, "unknownOfferIds": [i for i in body["offerIds"] if i not in self.offers]}

    def _intelligence_ranking_rank(self, body: Any) -> dict[str, Any]:
        """Mirrors the engine's contract: DB prices, hard filters re-applied, signed token."""
        f = body.get("filters") or {}
        facts = [self._facts(i) for i in body["offerIds"] if i in self.offers]
        kept, excluded = [], []
        for x in facts:
            price = x["pricing"]["prices"]["deliveredPaise"]
            if x["stockStatus"] == "OUT_OF_STOCK":
                excluded.append({"offerId": x["offerId"], "reason": "UNAVAILABLE"})
            elif "maxPricePaise" in f and price > f["maxPricePaise"]:
                excluded.append({"offerId": x["offerId"], "reason": "ABOVE_MAX_PRICE"})
            else:
                kept.append(x)
        kept.sort(key=lambda x: (x["pricing"]["prices"]["deliveredPaise"], x["offerId"]))
        ranked = [
            {
                "rank": n + 1,
                "offerId": x["offerId"],
                "score": 9000 - n * 100,
                "deliveredPricePaise": x["pricing"]["prices"]["deliveredPaise"],
                "rankingPricePaise": x["pricing"]["prices"]["deliveredPaise"],
                "components": {"price": 10000 - n * 100, "discount": None},
                "explanation": {
                    "summary": f"Rank {n + 1} on {x['sourceName']}",
                    "factors": [],
                    "versusNext": None,
                },
                "offer": x,
            }
            for n, x in enumerate(kept)
        ]
        self.ranking_tokens.append(f"token-{len(self.ranking_tokens)}")
        return {
            "requestedMode": body["mode"],
            "appliedMode": "best_value" if body["mode"] == "trending_deals" else body["mode"],
            "ranked": ranked,
            "excluded": excluded,
            "warnings": ["TRENDING_DATA_UNAVAILABLE: ranked as best_value instead"]
            if body["mode"] == "trending_deals"
            else [],
            "rankingToken": self.ranking_tokens[-1],
        }


class _HttpFailure(Exception):
    def __init__(self, status: int) -> None:
        self.status = status


class ScriptedLlm:
    """Returns scripted structured outputs (or raises) in order."""

    def __init__(
        self,
        *responses: BaseModel | dict[str, Any] | Exception,
        provider: str = "fake",
        model: str = "fake-1",
    ) -> None:
        self._responses = list(responses)
        self._provider, self._model = provider, model
        self.calls: list[str] = []

    @property
    def provider(self) -> str:
        return self._provider

    @property
    def model(self) -> str:
        return self._model

    async def generate(self, schema: type[T], system: str, user: str, *, name: str) -> LlmResult[T]:
        self.calls.append(name)
        if not self._responses:
            raise LlmError("no scripted response", provider=self._provider, retryable=False)
        nxt = self._responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        data = schema.model_validate(nxt.model_dump() if isinstance(nxt, BaseModel) else nxt)
        return LlmResult(data=data, usage=LlmUsage(120, 40), provider=self._provider, model=self._model)
