"""Search-understanding evaluation: hand-labelled queries → field-level accuracy.

Scores what PRODUCTION would act on, not the raw model output: the extracted
intent is passed through the same deterministic steps the query validator
runs without the API (budget grounding with `is_stated`, category mapping
with `match_category`, marketplace slug mapping). Spec canonicalisation
happens in the TypeScript intelligence service, so specs are compared after a
light, documented normalisation here.

    uv run python -m app.evals.intent_eval                      # rules extractor (deterministic)
    uv run python -m app.evals.intent_eval --provider configured  # the configured LLM (costs tokens)
    ... --split holdout --json out.json --show-failures

Labels: evals/search_queries.jsonl, guide in docs/search-quality-evaluation.md.
Fields a case does not mention are expected to be the schema default
(nothing invented: no budget, no brand, sort "best_value", …).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.nodes.query_validator import marketplace_slugs, match_category
from app.prompts.intent import INTENT_SYSTEM, intent_user_prompt
from app.providers.base import StructuredLlm
from app.providers.rules import extract_intent_by_rules
from app.schemas.intent import ExtractedIntent
from app.schemas.internal import CategoryRef
from app.utils.money import is_stated

DATASET = Path(__file__).resolve().parents[2] / "evals" / "search_queries.jsonl"

# Leaf categories from packages/db/src/seed-data.ts (the catalog the validator maps onto).
SEED_CATEGORIES = [
    CategoryRef(slug=s, name=n)
    for s, n in (
        ("smartphones", "Smartphones"),
        ("laptops", "Laptops"),
        ("tablets", "Tablets"),
        ("televisions", "Televisions"),
        ("audio", "Headphones & Speakers"),
        ("wearables", "Smartwatches & Wearables"),
        ("cameras", "Cameras"),
        ("gaming", "Gaming"),
        ("computer-accessories", "Computer Accessories"),
        ("mens-clothing", "Men's Clothing"),
        ("womens-clothing", "Women's Clothing"),
        ("footwear", "Footwear"),
        ("watches", "Watches"),
        ("refrigerators", "Refrigerators"),
        ("washing-machines", "Washing Machines"),
        ("air-conditioners", "Air Conditioners"),
        ("kitchen-appliances", "Kitchen Appliances"),
        ("furniture", "Furniture"),
        ("home-decor", "Home Decor"),
        ("beauty-personal-care", "Beauty and Personal Care"),
        ("sports-fitness", "Sports and Fitness"),
        ("books", "Books"),
        ("grocery", "Grocery"),
        ("automotive", "Automotive"),
    )
]

FIELDS = (
    "category",
    "brands",
    "excluded_brands",
    "min_price_rupees",
    "max_price_rupees",
    "specs",
    "launch_preference",
    "genuine_discount_only",
    "min_discount_percent",
    "sort_mode",
    "marketplaces",
    "compare_same_product",
    "payment_banks",
    "card_types",
    "memberships",
)
DEFAULTS: dict[str, Any] = {
    "category": None,
    "brands": [],
    "excluded_brands": [],
    "min_price_rupees": None,
    "max_price_rupees": None,
    "specs": {},
    "launch_preference": "any",
    "genuine_discount_only": False,
    "min_discount_percent": None,
    "sort_mode": "best_value",
    "marketplaces": [],
    "compare_same_product": False,
    "payment_banks": [],
    "card_types": [],
    "memberships": [],
}
SET_FIELDS = {"brands", "excluded_brands", "marketplaces", "payment_banks", "card_types", "memberships"}

_SPEC_NAMES = {
    "memory": "ram",
    "rom": "storage",
    "internal_storage": "storage",
    "ssd": "storage",
    "screen": "screen_size",
    "display": "screen_size",
    "display_size": "screen_size",
    "size": "screen_size",
    "star_rating": "energy_rating",
    "rating": "energy_rating",
    "battery_capacity": "battery",
    "graphics": "gpu",
    "cpu": "processor",
}
_UNITS = (
    (r"litres?|liters?|ltrs?", "l"),
    (r"tons?|tonnes?", "ton"),
    (r"inches|\"|”", "inch"),
    (r"stars?", "star"),
)


def norm_spec_name(name: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return _SPEC_NAMES.get(key, key)


def norm_spec_value(value: str) -> str:
    v = value.lower()
    for pattern, unit in _UNITS:
        v = re.sub(rf"(?<=[\d\s]){pattern}\b", unit, v)
    return re.sub(r"[\s\-]+", "", v)


@dataclass
class Effective:
    """The parts of an intent production acts on, after deterministic validation."""

    values: dict[str, Any]
    keywords: str


def effective(intent: ExtractedIntent, query: str) -> Effective:
    budget = {
        k: (v if v is not None and is_stated(v, query) else None)
        for k, v in (
            ("min_price_rupees", intent.min_price_rupees),
            ("max_price_rupees", intent.max_price_rupees),
        )
    }
    values: dict[str, Any] = {
        "category": match_category(intent, SEED_CATEGORIES),
        "brands": sorted({b.lower() for b in intent.brands}),
        "excluded_brands": sorted({b.lower() for b in intent.excluded_brands}),
        **budget,
        "specs": {norm_spec_name(s.name): norm_spec_value(s.value) for s in intent.required_specifications},
        "launch_preference": intent.launch_preference,
        "genuine_discount_only": intent.genuine_discount_only,
        "min_discount_percent": intent.min_discount_percent,
        "sort_mode": intent.sort_mode,
        "marketplaces": sorted(marketplace_slugs(intent.marketplaces)),
        "compare_same_product": intent.compare_same_product,
        "payment_banks": sorted({b.lower() for b in intent.payment_banks}),
        "card_types": sorted(intent.card_types),
        "memberships": sorted({m.lower() for m in intent.memberships}),
    }
    return Effective(values, intent.search_keywords)


def expected(case: dict[str, Any]) -> dict[str, Any]:
    out = dict(DEFAULTS)
    for k, v in case["expect"].items():
        if k not in DEFAULTS:
            raise ValueError(f"{case['id']}: unknown field {k!r}")
        if k in SET_FIELDS:
            v = sorted(x.lower() if k != "card_types" else x for x in v)
        elif k == "specs":
            v = {norm_spec_name(n): norm_spec_value(str(x)) for n, x in v.items()}
        out[k] = v
    return out


def keywords_clean(keywords: str) -> bool:
    """Marketplace keywords carry no stray punctuation tokens and no budget amounts."""
    tokens = keywords.split()
    if any(re.fullmatch(r"[^\w₹]+", t) for t in tokens):
        return False
    if re.search(r"[.,;:!?]$", keywords.strip()):
        return False
    return not re.search(r"(₹|\brs\.?)\s*\d|\b\d+\s*(k|lakhs?)\b", keywords.lower())


@dataclass
class CaseResult:
    id: str
    split: str
    query: str
    wrong: dict[str, tuple[Any, Any]] = field(default_factory=dict)  # field → (expected, got)
    keywords: str = ""
    keywords_clean: bool = True
    error: str | None = None


def load_cases(path: Path = DATASET) -> list[dict[str, Any]]:
    cases = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    ids = [c["id"] for c in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate case ids")
    for c in cases:
        expected(c)  # validates field names
    return cases


def score_case(case: dict[str, Any], intent: ExtractedIntent) -> CaseResult:
    eff = effective(intent, case["query"])
    exp = expected(case)
    res = CaseResult(case["id"], case["split"], case["query"], keywords=eff.keywords)
    for f in FIELDS:
        if eff.values[f] != exp[f]:
            res.wrong[f] = (exp[f], eff.values[f])
    res.keywords_clean = keywords_clean(eff.keywords)
    return res


async def extract(llm: StructuredLlm | None, query: str) -> ExtractedIntent:
    if llm is None:
        return extract_intent_by_rules(query)
    result = await llm.generate(ExtractedIntent, INTENT_SYSTEM, intent_user_prompt(query), name="eval")
    return result.data


async def run(cases: list[dict[str, Any]], llm: StructuredLlm | None = None) -> list[CaseResult]:
    out: list[CaseResult] = []
    for case in cases:
        try:
            out.append(score_case(case, await extract(llm, case["query"])))
        except Exception as err:  # a provider failure is a failed case, not a crash
            out.append(CaseResult(case["id"], case["split"], case["query"], error=str(err)[:300]))
    return out


def summarize(results: list[CaseResult]) -> dict[str, Any]:
    scored = [r for r in results if r.error is None]
    n = len(results)
    per_field = {f: round(sum(1 for r in scored if f not in r.wrong) / n, 4) if n else None for f in FIELDS}
    return {
        "cases": n,
        "errors": n - len(scored),
        "exact_match": round(sum(1 for r in scored if not r.wrong) / n, 4) if n else None,
        "field_accuracy": round(sum(len(FIELDS) - len(r.wrong) for r in scored) / (n * len(FIELDS)), 4)
        if n
        else None,
        "keywords_clean": round(sum(1 for r in scored if r.keywords_clean) / n, 4) if n else None,
        "per_field": per_field,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--provider", choices=["rules", "configured"], default="rules")
    p.add_argument("--split", choices=["dev", "holdout", "all"], default="all")
    p.add_argument("--json", type=Path, help="write the full report here")
    p.add_argument("--show-failures", action="store_true")
    args = p.parse_args(argv)

    cases = [c for c in load_cases() if args.split in ("all", c["split"])]
    llm: StructuredLlm | None = None
    label = "rules (keyword-rules-v1)"
    if args.provider == "configured":
        from app.config.settings import Settings
        from app.providers.factory import create_llm

        settings = Settings()
        llm = create_llm(settings)
        label = f"{llm.provider}/{llm.model}"

    results = asyncio.run(run(cases, llm))
    report: dict[str, Any] = {"extractor": label, "dataset": DATASET.name}
    for split in ("dev", "holdout"):
        part = [r for r in results if r.split == split]
        if part:
            report[split] = summarize(part)
    report["all"] = summarize(results)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if args.show_failures:
        for r in results:
            if r.error or r.wrong or not r.keywords_clean:
                print(f"\n[{r.id}] {r.query}", file=sys.stderr)
                if r.error:
                    print(f"  ERROR {r.error}", file=sys.stderr)
                for f, (want, got) in r.wrong.items():
                    print(f"  {f}: expected {want!r}, got {got!r}", file=sys.stderr)
                if not r.keywords_clean:
                    print(f"  keywords not clean: {r.keywords!r}", file=sys.stderr)
    if args.json:
        args.json.write_text(
            json.dumps(
                {**report, "cases": [r.__dict__ for r in results]}, indent=2, ensure_ascii=False, default=str
            ),
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
