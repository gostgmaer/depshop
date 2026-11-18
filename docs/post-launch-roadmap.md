# Post-launch roadmap

**Starting point (2026-11-18):** DealMind is **not launched** ([production-go-live.md](production-go-live.md)). Prompt 24 asked for optimisation driven by production usage, and there is none, so this increment did only what can be measured without it:

- a labelled search-understanding evaluation;
- the defects it exposed;
- an honest inventory of what is and isn't measurable.

Everything else is ordered below by expected impact and risk, each with the evidence that must exist before it's built.

**Classification:**

- IMPLEMENTED AND VERIFIED;
- IMPLEMENTED BUT NOT VERIFIED (built, not yet proven where it matters);
- BLOCKED (needs something outside the repository);
- RECOMMENDED FOR FUTURE WORK.

## Prompt 24 stages

| Stage                        | Result                                                                                                                                                                                                                                                                  | Classification                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1. Production baseline       | No production exists. Metric inventory written: 14 instrumented, 4 derivable, 5 missing ([product-analytics.md](product-analytics.md))                                                                                                                                  | **BLOCKED** (no production); inventory done                                             |
| 2. Search quality evaluation | 60-case labelled set (40 dev / 20 holdout), evaluator scoring the production validator path, quality gate in `pnpm check`. Holdout exact match **85 % → 95 %**. Fixed a **P1 production** category-mapping bug (headphones → smartphones) and Hinglish budget grounding | **IMPLEMENTED AND VERIFIED** (rules extractor); LLM evaluation **BLOCKED** (no account) |
| 3. Product matching          | Measured on 46 labelled pairs: precision 1.00, recall 0.77, 0 false merges. No change: the misses are deliberate review cases                                                                                                                                           | Measured; changes **RECOMMENDED** after review-queue data                               |
| 4. Deal intelligence         | Inventory: all requested modes exist except "historical opportunity"; trending refused for lack of data; volatility and seller reliability missing                                                                                                                      | **RECOMMENDED** (needs real price history)                                              |
| 5. Category intelligence     | Documented the existing 6 matching profiles and the procedure for adding a category                                                                                                                                                                                     | **RECOMMENDED:** consolidate config when the 3rd new category is added                  |
| 6. Personalization           | Not started                                                                                                                                                                                                                                                             | **RECOMMENDED**, after launch (needs real usage to be worth anything; see below)        |
| 7. AI cost                   | Instrumentation inventoried; per-model evaluation now possible                                                                                                                                                                                                          | Optimizations **BLOCKED** (no LLM baseline)                                             |
| 8. Marketplace reliability   | Resilience inventoried (parallel, circuit breaker, retries, rate limits, cache)                                                                                                                                                                                         | **BLOCKED:** no authorized source                                                       |
| 9. Admin analytics           | Existing views inventoried; four cheap gaps listed                                                                                                                                                                                                                      | **RECOMMENDED**                                                                         |
| 10. Regression validation    | Agent suite 92/92 (24 new), ruff and strict mypy clean                                                                                                                                                                                                                  | **IMPLEMENTED AND VERIFIED**                                                            |

**Not built: search feedback, feature flags, personalization, plan or pricing changes.** None has evidence behind it yet. Building them now would add surface without a measured reason.

## Next priorities, in order

| #   | Work                                                                                                                                                 | Why now                                              | Evidence needed                                          | Risk                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | ----------------------- |
| 1   | **Launch** (clear the gates in production-go-live.md)                                                                                                | Every other item needs real data                     | —                                                        | —                       |
| 2   | Run `intent_eval --provider configured` on the chosen model                                                                                          | The production quality number; picks the model       | LLM key                                                  | Low                     |
| 3   | **Budget direction check** in the validator (Q24-5: "except anything above 18000" read as a minimum)                                                 | Wrong-direction budgets silently invert results      | Already reproduced                                       | Low                     |
| 4   | Close the analytics gaps: compare-usage counter, buy-link impressions (CTR), cohorts, brand aggregate                                                | Makes the baseline complete                          | —                                                        | Low                     |
| 5   | Admin data-quality page (stale per source, `NOT_GENUINE` discounts, title-only matches)                                                              | First real offers will need it                       | First authorized source                                  | Low                     |
| 6   | Search result feedback (relevant / wrong match / wrong variant / wrong price), triaged by admins, never auto-applied                                 | Real labels for matching and ranking                 | Launch                                                   | Medium (privacy, abuse) |
| 7   | Grow the labelled sets from real data: k-anonymous popular queries; resolved match reviews                                                           | The current sets were written by the engineer        | 2–4 weeks of traffic                                     | Low                     |
| 8   | Deterministic intent for simple queries; intent cache keyed on query text only                                                                       | Cost                                                 | LLM tokens per search; per-model eval; repeat-query rate | Medium                  |
| 9   | Lightweight feature flags (an `AppSetting` row + admin toggle + audit log) for ranking weights, a new model, a new category                          | Needed when the first risky change ships, not before | A concrete change to gate                                | Low                     |
| 10  | Opt-in personalization (preferred brands/categories, budget), shown **separately** from objective rankings, off by default, deleted with the account | Engagement                                           | Retention data showing the need                          | Medium                  |
| 11  | Plan and limit changes                                                                                                                               | Monetization                                         | Free-to-paid conversion, limit-hit rates, cancellations  | Medium                  |

## Guardrails (unchanged)

- No tenancy.
- No affiliate input to ranking.
- No invented prices, specs or discounts.
- No unauthorized marketplace access.
- No metric claimed without a measurement.
- No change that lowers the holdout search score or matching precision without an explicit decision.
