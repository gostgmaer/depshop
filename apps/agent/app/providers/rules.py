"""Rule-based intent extraction (LLM_PROVIDER=rules).

NOT an LLM: a deterministic keyword parser for local development and tests
when no model API key is available. It is reported as provider "rules",
refused in production, and only extracts what it can match literally.
"""

from __future__ import annotations

import re
from typing import TypeVar

from pydantic import BaseModel

from app.providers.base import LlmError, LlmResult, LlmUsage
from app.schemas.intent import ExtractedIntent, SpecRequirement
from app.utils.money import parse_budget

T = TypeVar("T", bound=BaseModel)

CATEGORY_WORDS: dict[str, tuple[str, ...]] = {
    "smartphones": ("smartphone", "smart phone", "mobile phone", "mobile", "phone", "iphone"),
    "laptops": ("laptop", "notebook", "macbook"),
    "tablets": ("tablet", "ipad"),
    "televisions": ("television", "smart tv", "tv"),
    "audio": ("headphone", "earbud", "earphone", "speaker", "soundbar", "neckband", "airpods"),
    "wearables": ("smartwatch", "smart watch", "fitness band"),
    "air-conditioners": ("air conditioner", "inverter ac", "split ac", "window ac", "ac"),
    "washing-machines": ("washing machine", "washer"),
    "refrigerators": ("refrigerator", "fridge"),
    "kitchen-appliances": ("mixer grinder", "microwave", "air fryer", "kettle"),
    "footwear": ("shoe", "sneaker", "sandal"),
    "mens-clothing": ("men's shirt", "mens shirt", "men's jeans", "mens jeans"),
    "womens-clothing": ("kurti", "saree", "women's dress", "womens dress"),
    "books": ("book", "novel"),
}

_CATEGORY_PATTERNS: list[tuple[str, str, re.Pattern[str]]] = [
    (slug, word, re.compile(rf"\b{re.escape(word)}(?:e?s)?\b"))
    for slug, words in CATEGORY_WORDS.items()
    for word in words
]


def category_from_text(text: str) -> str | None:
    """The catalog slug for the product a phrase names, matched on WHOLE words.

    Substring matching mapped "headphones" to smartphones ("phone") and
    "backpacks"/"across" to air conditioners ("ac"). When several categories
    are named ("soundbar for TV"), the one named first is the product; a tie
    at the same position goes to the longer word ("smart tv" over "tv").
    """
    t = " ".join(text.lower().split())
    best: tuple[int, int, str] | None = None
    for slug, word, pattern in _CATEGORY_PATTERNS:
        if m := pattern.search(t):
            key = (m.start(), -len(word), slug)
            if best is None or key < best:
                best = key
    return best[2] if best else None


# Product lines that belong to exactly one brand ("iPhone" names Apple). Lines
# shared across brands or reused for other products are deliberately absent.
LINE_BRANDS: dict[str, str] = {
    "iphone": "apple",
    "ipad": "apple",
    "macbook": "apple",
    "airpods": "apple",
    "galaxy": "samsung",
    "pixel": "google",
}

KNOWN_BRANDS = (
    "apple",
    "samsung",
    "xiaomi",
    "redmi",
    "poco",
    "oneplus",
    "realme",
    "oppo",
    "vivo",
    "iqoo",
    "motorola",
    "nothing",
    "google",
    "hp",
    "dell",
    "lenovo",
    "asus",
    "acer",
    "msi",
    "sony",
    "lg",
    "boat",
    "jbl",
    "bose",
    "philips",
    "whirlpool",
    "godrej",
    "haier",
    "voltas",
    "daikin",
    "blue star",
    "bajaj",
    "prestige",
    "tcl",
    "nike",
    "adidas",
    "puma",
    "levi's",
    "acme",
    "zenith",
    "orbit",
)
MARKETPLACES = {
    "amazon": "amazon_in",
    "flipkart": "flipkart",
    "croma": "croma",
    "reliance digital": "reliance_digital",
    "tata cliq": "tata_cliq",
    "tatacliq": "tata_cliq",
}


def _find_specs(t: str) -> list[SpecRequirement]:
    specs: list[SpecRequirement] = []
    if m := re.search(r"(\d+)\s*gb\s*(?:of\s*)?ram", t):
        specs.append(SpecRequirement(name="ram", value=f"{m.group(1)}GB"))
    if m := re.search(r"(\d+)\s*(gb|tb)\s*(?:of\s*)?(?:storage|rom|ssd|internal)", t):
        specs.append(SpecRequirement(name="storage", value=f"{m.group(1)}{m.group(2).upper()}"))
    if m := re.search(r"(\d+(?:\.\d+)?)\s*-?\s*ton", t):
        specs.append(SpecRequirement(name="capacity", value=f"{m.group(1)} ton"))
    if m := re.search(r"(\d+(?:\.\d+)?)\s*kg", t):
        specs.append(SpecRequirement(name="capacity", value=f"{m.group(1)} kg"))
    if m := re.search(r"(\d+(?:\.\d+)?)\s*(?:l|litre|liter)s?\b", t):
        specs.append(SpecRequirement(name="capacity", value=f"{m.group(1)} L"))
    if not any(s.name == "storage" for s in specs):
        # A bare size with no "RAM" after it ("iPhone with 256GB") is storage when it can only be storage.
        for m in re.finditer(r"\b(\d{1,4})\s*(gb|tb)\b(?!\s*(?:of\s*)?(?:ram|memory))", t):
            if m.group(2) == "tb" or int(m.group(1)) >= 32:
                specs.append(SpecRequirement(name="storage", value=f"{m.group(1)}{m.group(2).upper()}"))
                break
    if m := re.search(r"\b(\d{2,3}(?:\.\d)?)\s*-?\s*(?:inch(?:es)?|\"|”)", t):
        specs.append(SpecRequirement(name="screen_size", value=f"{m.group(1)} inch"))
    if m := re.search(r"\b([1-5])\s*-?\s*star\b", t):
        specs.append(SpecRequirement(name="energy_rating", value=f"{m.group(1)} star"))
    if m := re.search(r"\b(\d{3,5})\s*mah\b", t):
        specs.append(SpecRequirement(name="battery", value=f"{m.group(1)} mAh"))
    if m := re.search(r"\b(i[3579]|ryzen\s*[3579]|core\s*ultra\s*[579])\b", t):
        specs.append(SpecRequirement(name="processor", value=m.group(1)))
    if m := re.search(r"\b(rtx|gtx|rx)\s*(\d{4})\b", t):
        specs.append(SpecRequirement(name="gpu", value=f"{m.group(1).upper()} {m.group(2)}"))
    return specs


def clean_keywords(text: str) -> str:
    """Marketplace keywords: no budget amounts, no stray punctuation."""
    k = re.sub(r"(₹|rs\.?)\s*[\d,]+(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(k|lakhs?|lac|thousand)\b", " ", text)
    k = re.sub(r"[,;:!?()]+|\.(?=\s|$)", " ", k)
    return " ".join(t for t in k.split() if re.search(r"\w", t))


# Eligibility words (only what the user states about themselves).
BANKS = ["HDFC", "ICICI", "SBI", "Axis", "Kotak", "IDFC", "Yes Bank", "AU", "RBL", "OneCard"]
MEMBERSHIPS = {
    "flipkart plus": "Flipkart Plus",
    "amazon prime": "Amazon Prime",
    "prime member": "Amazon Prime",
}


def extract_intent_by_rules(query: str) -> ExtractedIntent:
    t = f" {' '.join(query.lower().split())} "
    category = category_from_text(t)
    excluded = {
        b for b in KNOWN_BRANDS if re.search(rf"(?:not|except|no|without|other than)\s+{re.escape(b)}\b", t)
    }
    brands = [b for b in KNOWN_BRANDS if re.search(rf"\b{re.escape(b)}\b", t) and b not in excluded]
    for line, brand in LINE_BRANDS.items():
        if re.search(rf"\b{line}", t) and brand not in brands and brand not in excluded:
            brands.append(brand)
    min_rupees, max_rupees = parse_budget(query)
    sort = "best_value"
    if re.search(r"cheapest|lowest price|least expensive", t):
        sort = "lowest_price"
    elif re.search(r"(highest|biggest|best|maximum|significant)\s+(genuine\s+)?discount", t):
        sort = "highest_discount"
    elif re.search(r"(newest|latest)( launches)? first|sort(ed)? by (newest|latest|launch)", t):
        # Ordering by launch date only when asked; "newest X" is a launch filter (below).
        sort = "recently_launched"
    elif re.search(r"price drops?|dropped in price", t):
        sort = "price_drop"
    marketplaces = [slug for name, slug in MARKETPLACES.items() if name in t]
    keywords = re.sub(
        r"\b(find|show|me|a|an|the|for|with|under|below|above|best|value|cheapest|newly|recently|launched|"
        r"highest|genuine|discount|discounts|on|across|and|compare|same|significant|products?)\b",
        " ",
        query.lower(),
    )
    keywords = clean_keywords(keywords) or query
    return ExtractedIntent(
        category=category,
        brands=brands,
        excluded_brands=sorted(excluded),
        min_price_rupees=min_rupees,
        max_price_rupees=max_rupees,
        required_specifications=_find_specs(t),
        launch_preference="recently_launched"
        if re.search(r"newly launched|recently launched|new launch|latest|newest|just launched", t)
        else "any",
        genuine_discount_only=bool(re.search(r"genuine|real discount|significant discount", t)),
        min_discount_percent=int(m.group(1))
        if (m := re.search(r"(\d{1,2})\s*%\s*(?:off|discount)", t))
        else None,
        sort_mode=sort,
        marketplaces=marketplaces,
        payment_banks=[b for b in BANKS if re.search(rf"\b{b.lower()}\b", t)],
        card_types=[c for c, w in (("CREDIT", "credit card"), ("DEBIT", "debit card")) if w in t],
        memberships=[m for k, m in MEMBERSHIPS.items() if k in t],
        compare_same_product=bool(re.search(r"\bcompare\b.*\b(across|between|on)\b", t)),
        search_keywords=keywords[:200] if len(keywords) >= 2 else query[:200],
    )


class RuleBasedLlm:
    """Implements the StructuredLlm protocol for ExtractedIntent only."""

    @property
    def provider(self) -> str:
        return "rules"

    @property
    def model(self) -> str:
        return "keyword-rules-v1"

    async def generate(self, schema: type[T], system: str, user: str, *, name: str) -> LlmResult[T]:
        if schema is not ExtractedIntent:
            raise LlmError("The rule-based provider only extracts intent", provider="rules", retryable=False)
        # The prompt wraps the query ("User request: ..."); parse only the user's words.
        intent = extract_intent_by_rules(user.split("User request:", 1)[-1].strip())
        return LlmResult(
            data=schema.model_validate(intent.model_dump()),
            usage=LlmUsage(),
            provider="rules",
            model=self.model,
        )
