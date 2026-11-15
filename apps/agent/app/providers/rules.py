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
    "smartphones": ("smartphone", "smart phone", "mobile phone", "mobile", "phone"),
    "laptops": ("laptop", "notebook", "macbook"),
    "tablets": ("tablet", "ipad"),
    "televisions": ("television", "smart tv", "tv"),
    "audio": ("headphone", "earbud", "earphone", "speaker", "soundbar"),
    "wearables": ("smartwatch", "smart watch", "fitness band"),
    "air-conditioners": ("air conditioner", "inverter ac", "split ac", "window ac", " ac"),
    "washing-machines": ("washing machine", "washer"),
    "refrigerators": ("refrigerator", "fridge"),
    "kitchen-appliances": ("mixer grinder", "microwave", "air fryer", "kettle"),
    "footwear": ("shoe", "sneaker", "sandal"),
    "mens-clothing": ("men's shirt", "mens shirt", "men's jeans", "mens jeans"),
    "womens-clothing": ("kurti", "saree", "women's dress", "womens dress"),
    "books": ("book", "novel"),
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
    return specs


# Eligibility words (only what the user states about themselves).
BANKS = ["HDFC", "ICICI", "SBI", "Axis", "Kotak", "IDFC", "Yes Bank", "AU", "RBL", "OneCard"]
MEMBERSHIPS = {
    "flipkart plus": "Flipkart Plus",
    "amazon prime": "Amazon Prime",
    "prime member": "Amazon Prime",
}


def extract_intent_by_rules(query: str) -> ExtractedIntent:
    t = f" {' '.join(query.lower().split())} "
    category = next((slug for slug, words in CATEGORY_WORDS.items() if any(w in t for w in words)), None)
    excluded = {
        b for b in KNOWN_BRANDS if re.search(rf"(?:not|except|no|without|other than)\s+{re.escape(b)}\b", t)
    }
    brands = [b for b in KNOWN_BRANDS if re.search(rf"\b{re.escape(b)}\b", t) and b not in excluded]
    min_rupees, max_rupees = parse_budget(query)
    sort = "best_value"
    if re.search(r"cheapest|lowest price|least expensive", t):
        sort = "lowest_price"
    elif re.search(r"(highest|biggest|best|maximum|significant)\s+(genuine\s+)?discount", t):
        sort = "highest_discount"
    elif re.search(r"newest|latest launch", t):
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
    keywords = re.sub(r"(₹|rs\.?)\s*[\d,]+|\d[\d,]*\s*(k|lakhs?|thousand)\b", " ", keywords)
    keywords = " ".join(keywords.split()) or query
    return ExtractedIntent(
        category=category,
        brands=brands,
        excluded_brands=sorted(excluded),
        min_price_rupees=min_rupees,
        max_price_rupees=max_rupees,
        required_specifications=_find_specs(t),
        launch_preference="recently_launched"
        if re.search(r"newly launched|recently launched|new launch|latest|just launched", t)
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
