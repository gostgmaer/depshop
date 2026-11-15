"""Response generation from VERIFIED structured results.

A deterministic template is always produced. When LLM narration is enabled,
the model may rephrase it, but its text is rejected (and the template used)
if it contains any price/percentage not present in the facts, or any URL.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field

from app.prompts.response import RESPONSE_SYSTEM
from app.providers.base import LlmError, LlmUsage, StructuredLlm


class Narration(BaseModel):
    summary: str = Field(min_length=10, max_length=2_000)


def format_rupees(paise: int) -> str:
    """₹ with Indian digit grouping; paise shown only when non-zero."""
    rupees, p = divmod(int(paise), 100)
    s = str(rupees)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups: list[str] = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join([*groups, tail])
    return f"₹{s}" + (f".{p:02d}" if p else "")


def format_bp(bp: int) -> str:
    whole, frac = divmod(int(bp), 100)
    return f"{whole}%" if frac == 0 else f"{whole}.{frac:02d}%"


@dataclass(slots=True)
class NarrationResult:
    text: str
    narrated_by_llm: bool
    usage: LlmUsage
    rejected_reason: str | None = None


def facts_for(deals: list[dict[str, Any]], status: str, source_runs: list[dict[str, Any]]) -> dict[str, Any]:
    top = []
    for d in deals[:5]:
        o, p = d["offer"], d["offer"]["pricing"]
        dd, a = p["directDiscount"], p["assessment"]
        discounted = dd["status"] == "OK" and (dd.get("percentBp") or 0) > 0
        top.append(
            {
                "rank": d["rank"],
                "product": o["productName"],
                "marketplace": o["sourceName"],
                "price": format_rupees(p["prices"]["deliveredPaise"]),
                "mrp": format_rupees(dd["mrpPaise"]) if discounted else None,
                "discount_vs_mrp": format_bp(dd["percentBp"]) if discounted else None,
                "discount_verdict": a["verdict"],
                "genuine_discount_vs_typical_price": format_bp(a["genuineDiscountBp"])
                if a["genuineDiscountBp"]
                else None,
                "price_history": (p.get("history") or {}).get("lowestClaim", {}).get("text"),
                "stock": o["stockStatus"],
                "sample_data": o["isSample"],
            }
        )
    failed = [r["sourceId"] for r in source_runs if r["status"] in ("FAILED", "TIMED_OUT")]
    return {"status": status, "result_count": len(deals), "top_results": top, "unavailable_sources": failed}


def template_summary(facts: dict[str, Any], filter_note: str | None) -> str:
    n = facts["result_count"]
    parts: list[str] = []
    if n == 0:
        parts.append("No products matched your requirements from the sources searched.")
    else:
        best = facts["top_results"][0]
        verdict = {
            "GENUINE": "the price is below its typical recent price",
            "NOT_GENUINE": "its MRP discount is not lower than its usual price",
            "INSUFFICIENT_HISTORY": "there is not enough price history yet to verify the discount",
        }[best["discount_verdict"]]
        parts.append(
            f"Found {n} matching offer{'s' if n != 1 else ''}. Top pick: {best['product']} on "
            f"{best['marketplace']} at {best['price']}"
            + (f" ({best['discount_vs_mrp']} below MRP {best['mrp']})" if best["discount_vs_mrp"] else "")
            + f"; {verdict}."
        )
        if any(r["sample_data"] for r in facts["top_results"]):
            parts.append("Some results come from sample/mock sources and are not real offers.")
    if facts["unavailable_sources"]:
        parts.append(f"Partial results: {', '.join(facts['unavailable_sources'])} could not be searched.")
    if filter_note:
        parts.append(filter_note)
    return " ".join(parts)


_MONEY_OR_PERCENT = re.compile(r"₹\s?[\d,]+(?:\.\d{1,2})?|\d+(?:\.\d+)?\s?%")


def _allowed_tokens(facts: dict[str, Any]) -> set[str]:
    blob = json.dumps(facts, ensure_ascii=False)
    return {re.sub(r"\s", "", m) for m in _MONEY_OR_PERCENT.findall(blob)}


def validate_narration(text: str, facts: dict[str, Any]) -> str | None:
    """Returns a rejection reason, or None when the text only uses given facts."""
    if re.search(r"https?://|www\.", text, re.I):
        return "contains a URL"
    allowed = _allowed_tokens(facts)
    for token in _MONEY_OR_PERCENT.findall(text):
        if re.sub(r"\s", "", token) not in allowed:
            return f"unsupported figure {token!r}"
    return None


async def narrate(
    llm: StructuredLlm | None, facts: dict[str, Any], filter_note: str | None, *, enabled: bool
) -> NarrationResult:
    template = template_summary(facts, filter_note)
    if not enabled or llm is None or facts["result_count"] == 0:
        return NarrationResult(template, False, LlmUsage())
    try:
        result = await llm.generate(
            Narration,
            RESPONSE_SYSTEM,
            json.dumps({"facts": facts, "note": filter_note}, ensure_ascii=False),
            name="generate_response",
        )
    except LlmError as err:
        return NarrationResult(template, False, LlmUsage(), rejected_reason=f"llm unavailable: {err}"[:200])
    reason = validate_narration(result.data.summary, facts)
    if reason:
        return NarrationResult(template, False, result.usage, rejected_reason=reason)
    return NarrationResult(result.data.summary.strip(), True, result.usage)
