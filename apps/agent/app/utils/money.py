"""Rupee amounts as written in Indian shopping queries ("₹35,000", "35k",
"1.5 lakh", "Rs. 25000"). Integer rupees only; paise conversion is exact
(rupees * 100). Used to ground LLM-extracted budgets in the user's own words."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Literal

Direction = Literal["min", "max"]

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
    direction = amount_direction(text, first)
    if direction == "min":
        return first.rupees, None
    if direction == "max":
        return None, first.rupees
    return None, None


_MIN_BEFORE = re.compile(r"(above|over|more than|at least|min(?:imum)?|from|starting)\s*$")
_MAX_BEFORE = re.compile(
    r"(under|below|less than|upto|up to|within|budget(?: of)?|max(?:imum)?|cheaper than|not exceeding)\s*$"
)
# A negation shortly before a direction word flips it: "not more than X" and
# "except anything above X" are maximums; "not under X" is a minimum.
_NEGATION = re.compile(
    # Only filler words may sit between the negation and the direction word, so a brand
    # ("Nothing phone under 40k") or an exclusion ("except Samsung under 30000") never flips it.
    r"\b(not|no|never|except|excluding|nothing|anything but)"
    r"(?:\s+(?:anything|any|something|one|priced|costing|that is|which is))?\s*$"
)


def amount_direction(text: str, amount: Amount) -> Direction | None:
    """Whether the user's own words make this amount a minimum or a maximum (None = unstated)."""
    t = text.lower()
    before = t[max(0, amount.start - 40) : amount.start]
    rules: tuple[tuple[re.Pattern[str], Direction, Direction], ...] = (
        (_MIN_BEFORE, "min", "max"),
        (_MAX_BEFORE, "max", "min"),
    )
    for pattern, direction, flipped in rules:
        if m := pattern.search(before):
            return flipped if _NEGATION.search(before[: m.start()]) else direction
    # Hindi/Hinglish puts the direction AFTER the amount: "20k ke andar", "15000 tak", "10k se zyada".
    after = t[amount.end : amount.end + 16]
    if re.match(_HINGLISH_MAX, after):
        return "max"
    if re.match(_HINGLISH_MIN, after):
        return "min"
    return None


def stated_directions(rupees: int, text: str) -> set[Direction]:
    """Directions the query gives this exact amount (empty when it appears without one).

    A range ("between A and B", "A to B") makes its lower end a minimum and its
    upper end a maximum."""
    amounts = extract_rupee_amounts(text)
    lo, hi = parse_budget(text)
    if lo is not None and hi is not None:
        bounds: tuple[tuple[Direction, int], ...] = (("min", lo), ("max", hi))
        return {d for d, v in bounds if v == rupees}
    return {d for a in amounts if a.rupees == rupees and (d := amount_direction(text, a)) is not None}
