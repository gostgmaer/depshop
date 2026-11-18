# Search quality evaluation

Measures how well DealMind understands a shopping request: the step that decides category, budget, specs, brands and sort order before any marketplace is searched. Everything downstream (filters, ranking) depends on it.

## What exists

| Item                                         | Location                                       |
| -------------------------------------------- | ---------------------------------------------- |
| Labelled dataset: 60 queries, 15 fields each | `apps/agent/evals/search_queries.jsonl`        |
| Evaluator                                    | `apps/agent/app/evals/intent_eval.py`          |
| Quality gate (runs in `pnpm check`)          | `apps/agent/tests/test_search_quality_eval.py` |

```sh
cd apps/agent
uv run python -m app.evals.intent_eval --show-failures              # deterministic rules extractor
uv run python -m app.evals.intent_eval --provider configured        # the configured LLM (needs keys; costs tokens)
uv run python -m app.evals.intent_eval --split holdout --json report.json
```

**What it scores is what production acts on.** The extracted intent goes through the same deterministic steps the query validator runs:

- budget grounding: an amount that isn't literally in the query is dropped;
- category mapping onto the real catalog categories;
- marketplace slug mapping.

Spec names and values are normalised lightly (`16 GB` = `16gb`, `litres` = `l`). Exact spec canonicalisation happens in the TypeScript intelligence service and is covered by its own tests.

## Dataset

- **60 queries** across smartphones, laptops, tablets, TVs, audio, wearables, ACs, refrigerators, washing machines, kitchen appliances and footwear. They cover:
  - the six example queries from the Prompt 24 brief;
  - Indian budget formats (`₹35,000`, `35k`, `1.2 lakh`, `Rs. 65,000`, ranges);
  - brand exclusion;
  - named marketplaces, banks, card types and memberships;
  - one Hinglish query.
- **Split:**
  - 40 **dev** cases, used to find and fix problems;
  - 20 **holdout** cases, written before any fix and never tuned against. Report the holdout number as the quality figure.
- **Labels come from the literal wording of the query, never from a model's output.**

**Limitations:**

- Everything was written by one person (the engineer, not shoppers), so it is a regression and coverage set, not a sample of real traffic.
- 20 holdout cases is small: one case is 5 points of exact match.
- **Replace or extend it with anonymised, k-anonymous real queries after launch** (from the admin "popular queries" and "empty-result queries" lists).

### Labelling guide

| Field    | Rule                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget   | Only amounts the user states, with direction: "under/below/within/ke andar/tak" → max; "above/over/at least/se zyada" → min; "between A and B" → both. Never inferred.                                                                                                       |
| Category | The product the user names; in "X for Y", it's X ("soundbar for TV" → audio). None when no product is named.                                                                                                                                                                 |
| Brands   | Brands named, plus a brand named implicitly by a product line only that brand sells (iPhone/iPad/MacBook/AirPods → Apple, Galaxy → Samsung, Pixel → Google). Excluded brands ("not", "except", "other than") are never in `brands`.                                          |
| Specs    | Only stated values: RAM, storage (a bare `≥ 32GB`/`TB` without "RAM" is storage), capacity (ton/kg/L), screen size (inch), energy rating (star), battery (mAh), processor, GPU. "At least 300L" is labelled `300l`; the minimum semantics are a known gap of the spec model. |
| Launch   | "newly/recently launched", "new launch", "latest", "newest" → `launch_preference: recently_launched`.                                                                                                                                                                        |
| Sort     | "cheapest/lowest price" → `lowest_price`; "highest/biggest genuine discount" → `highest_discount`; "price drop / dropped in price" → `price_drop`. Launch-date order only when requested ("newest first", "sorted by launch"). Otherwise `best_value`.                       |
| Genuine  | "genuine", "real discount", "significant discount" → `genuine_discount_only`.                                                                                                                                                                                                |
| Compare  | "compare … across/between/on" → `compare_same_product`.                                                                                                                                                                                                                      |

## Results (measured 2026-11-18)

Extractor: `rules` (`keyword-rules-v1`), the deterministic parser, plus the production validator steps. **The rules parser is not only a dev tool:** production uses it whenever the admin disables the model or the monthly token budget is used up (`providers/configurable.py`).

| Split            | Metric                     | Before     | After                                    |
| ---------------- | -------------------------- | ---------- | ---------------------------------------- |
| **holdout (20)** | exact-match intents        | **85.0 %** | **95.0 %**                               |
| holdout          | field accuracy (15 fields) | 98.7 %     | 99.3 %                                   |
| dev (40)         | exact-match intents        | 60.0 %     | 97.5 % _(tuned on; not a quality claim)_ |
| all (60)         | exact-match intents        | 68.3 %     | 96.7 %                                   |
| all              | clean marketplace keywords | 96.7 %     | 100 %                                    |

Per field, all 60, before → after:

- category 91.7 → 98.3 %;
- brands 93.3 → 100 %;
- specs 83.3 → 100 %;
- max budget 96.7 → 98.3 %;
- launch and sort 98.3 → 100 %.

**The configured LLM has not been evaluated:** no LLM credentials exist (BLOCKED). Run `--provider configured` as soon as they do. It is the number that matters for production.

### Defects found by the evaluation

| ID    | Sev.   | Defect                                                                                                                                                                                                                 | Affects                                                                     | Status                                                                            |
| ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q24-1 | **P1** | Category words were matched as **substrings**: an LLM category of "headphones" or "earphones" filtered the search to **smartphones** ("phone"); "backpacks" and "space heaters" mapped to **air conditioners** ("ac"). | **Production** (`match_category` in the query validator) and the dev parser | Fixed: whole-word matching, first-named product wins. Regression tests added.     |
| Q24-2 | P2     | A Hinglish budget ("40000 tak", "20k ke andar") wasn't recognised as money, so **a correct LLM budget was discarded by grounding** as "not stated".                                                                    | Production (`is_stated`)                                                    | Fixed: direction words after the amount count. Tested.                            |
| Q24-3 | P3     | Keywords kept stray punctuation and decimal budgets ("… storage .", "rtx 4060 1.").                                                                                                                                    | Rules parser (dev, and production when the LLM budget is exhausted)         | Fixed                                                                             |
| Q24-4 | P3     | The dev parser missed screen size, energy rating, battery, processor, GPU and bare storage; and product-line brands.                                                                                                   | Rules parser (dev, and production when the LLM budget is exhausted)         | Fixed                                                                             |
| Q24-5 | P2     | "except anything above 18000" is read as a **minimum** of ₹18,000. Grounding (`is_stated`) checks that an amount is present, **not its direction**, so production would also accept an LLM that flipped it.            | Production grounding                                                        | **Open** (holdout case h08; not tuned). Next: a direction check in the validator. |
| Q24-6 | P3     | "Pixel 8" doesn't imply smartphones.                                                                                                                                                                                   | Rules parser (dev, and production when the LLM budget is exhausted)         | Open, by choice: inferring a category from a product line is too speculative.     |

## Not measured (and why)

| Requested measure                     | Status                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Intent accuracy of the production LLM | **BLOCKED:** no LLM account                                                                         |
| Product-matching accuracy             | Measured separately: [product-matching-evaluation.md](product-matching-evaluation.md)               |
| Ranking relevance on real results     | **BLOCKED:** no live marketplace data. See [deal-ranking-evaluation.md](deal-ranking-evaluation.md) |
| Source selection quality              | **BLOCKED:** every real source is pending authorization                                             |
