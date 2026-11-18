"""Rupee amounts as written in Indian shopping queries ("₹35,000", "35k",
"1.5 lakh", "Rs. 25000"). Integer rupees only; paise conversion is exact
(rupees * 100). Used to ground LLM-extracted budgets in the user's own words."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

_MULT = {
    "k": 1_000,
    "thousand": 1_000,
    "lakh": 100_000,
    "lakhs": 100_000,
    "lac": 100_000,
    "l": 100_000,
    "cr": 10_000_000,
    "crore": 10_000_000,
    "crores": 10_000_000,
}
_PRICE_WORDS = (
    r"(?:under|below|less than|upto|up to|within|budget(?: of)?|max(?:imum)?|around|about"
    r"|above|over|more than|at least|min(?:imum)?|from|between|and|to|-)"
)

# Hindi/Hinglish direction words that FOLLOW an amount ("20k ke andar", "15000 tak").
_HINGLISH_MAX = r"\s*(?:ke\s+andar|tak|se\s+kam|ke\s+(?:niche|neeche))\b"
_HINGLISH_MIN = r"\s*se\s+(?:zyada|jyada|upar|adhik)\b"
_HINGLISH_AFTER = re.compile(f"(?:{_HINGLISH_MAX})|(?:{_HINGLISH_MIN})")

_AMOUNT = re.compile(
    r"(?P<cur>₹|rs\.?|inr|rupees?)?\s*(?P<num>\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*(?P<mult>k|thousand|lakhs?|lac|l|crores?|cr)?\b(?P<cur2>\s*(?:rupees?|rs\.?|inr|/-))?",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class Amount:
    rupees: int
    start: int
    end: int


def extract_rupee_amounts(text: str) -> list[Amount]:
    """Amounts that are clearly money: a currency marker, a k/lakh/crore suffix,
    or a number ≥ 100 right after a price word. "8GB", "1.5 ton", "55 inch" never match."""
    out: list[Amount] = []
    for m in _AMOUNT.finditer(text):
        num, mult = m.group("num"), (m.group("mult") or "").lower()
        has_currency = bool(m.group("cur") or m.group("cur2"))
        after = text[m.end() : m.end() + 8].lower()
        if (
            re.match(r"\s*(gb|tb|mb|ton|kg|l\b|litre|liter|inch|in\b|hz|mp|w\b|mah|cm|mm|%)", after)
            and not has_currency
        ):
            continue
        if mult == "l" and not has_currency:
            continue  # "1.5 l" is volume unless marked as money
        try:
            value = Decimal(num.replace(",", ""))
        except InvalidOperation:
            continue
        before = text[max(0, m.start() - 16) : m.start()].lower()
        follows = _HINGLISH_AFTER.match(text[m.end() : m.end() + 16].lower()) is not None
        priced = re.search(_PRICE_WORDS + r"\s*$", before) is not None or follows
        if not (has_currency or mult or (priced and value >= 100)):
            continue
        rupees = int(value * _MULT.get(mult, 1))
        out.append(Amount(rupees, m.start(), m.end()))
    return out


def is_stated(rupees: int, text: str) -> bool:
    """True when this exact rupee amount appears in the text."""
    return any(a.rupees == rupees for a in extract_rupee_amounts(text))


def parse_budget(text: str) -> tuple[int | None, int | None]:
    """(min_rupees, max_rupees) from explicit phrasing; None when not stated."""
    t = text.lower()
    amounts = extract_rupee_amounts(text)
    if not amounts:
        return None, None
    between = re.search(r"between\s+(.+?)\s+(?:and|to|-)\s+(.+?)(?:\s|$)", t)
    if (between or re.search(r"\d\s*(?:to|-)\s*(?:₹|rs\.?)?\s*\d", t)) and len(amounts) >= 2:
        lo, hi = sorted((amounts[0].rupees, amounts[1].rupees))
        return lo, hi
    first = amounts[0]
    before = t[max(0, first.start - 16) : first.start]
    if re.search(r"(above|over|more than|at least|min(?:imum)?|from|starting)\s*$", before):
        return first.rupees, None
    if re.search(
        r"(under|below|less than|upto|up to|within|budget(?: of)?|max(?:imum)?|cheaper than)\s*$", before
    ):
        return None, first.rupees
    # Hindi/Hinglish puts the direction AFTER the amount: "20k ke andar", "15000 tak", "10k se zyada".
    after = t[first.end : first.end + 16]
    if re.match(_HINGLISH_MAX, after):
        return None, first.rupees
    if re.match(_HINGLISH_MIN, after):
        return first.rupees, None
    return None, None
