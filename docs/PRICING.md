# Pricing, genuine discounts and deal ranking (Phase 3.3)

Deterministic TypeScript, independent of LangGraph and of any LLM. Every
price comes from the shared catalog (`ProductOffer` + append-only
`PriceSnapshot`). Callers pass offer ids and the user's stated eligibility,
never prices. The Python agent orchestrates these services; it never
calculates an authoritative price, discount or rank.

Code: `packages/intelligence/src/pricing/` and `packages/intelligence/src/ranking/`

| Path                                                                  | Role                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pricing/calculations/direct-discount.ts`                             | MRP − selling price, validation                                                               |
| `pricing/calculations/effective-price.ts`                             | Price ladder (base → delivered → coupon / bank / membership; cashback and exchange separate)  |
| `pricing/calculations/emi.ts`                                         | EMI cost transparency                                                                         |
| `pricing/offer-conditions/evaluate.ts`                                | Conditional-benefit status (VERIFIED / UNVERIFIED / EXPIRED / INELIGIBLE)                     |
| `pricing/historical-prices/history.ts`                                | 7/30/90/180-day stats, coverage, trend, lowest-price claims, verified drops                   |
| `pricing/pricing.ts`                                                  | Genuine-discount verdict vs the offer's own 90-day median (Phase 3.1, now BigInt)             |
| `pricing/engine.ts`, `pricing/service.ts`                             | `calculatePricing` (pure); `PricingService` (DB loading, batching)                            |
| `pricing/schemas/`                                                    | Zod: stored offer conditions, eligibility context, response schemas                           |
| `ranking/filters`, `scorers`, `strategies`, `explainers`, `engine.ts` | Hard filters, score components, mode strategies, explanations, `rankOffers` / `compareOffers` |

## Money

- All arithmetic is **BigInt paise** (`bigPaise`, `ratioBp`, `applyBp`, `minBig`/`maxBig` in `@dealmind/shared`).
- Results are returned as JSON numbers only after a safe-integer check (`paiseFromBig`).
- Percentages are **basis points rounded down** (16.667% → 1666 bp → "16.66%"), so a discount is never overstated.
- Percentage benefits are rounded down too: 10% of ₹24,999.99 = ₹2,499.99.
- The shared `discountBasisPoints` helper now uses the exact BigInt ratio. It used float division before.

## Direct discount

`Direct discount = MRP − selling price`; `% = (MRP − selling) / MRP × 100`.

| Status                | When                                                             | Discount              |
| --------------------- | ---------------------------------------------------------------- | --------------------- |
| `OK`                  | valid MRP ≥ selling price                                        | amount + %            |
| `NO_MRP`              | the source didn't state an MRP                                   | none (not fabricated) |
| `INVALID_MRP`         | MRP = 0                                                          | none                  |
| `ABOVE_MRP`           | selling > MRP, no exception: a data problem, flagged             | none                  |
| `ABOVE_MRP_EXCEPTION` | selling > MRP with a source-stated `pricingException` and reason | 0                     |

A negative or fractional price throws. Cashback, bank, coupon and every other
conditional benefit are never part of the direct discount.

## Price ladder

| Price                 | Definition                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A. Base selling price | the marketplace's current price                                                                                       |
| B. Delivered price    | A + shipping + **mandatory** fees (optional fees are listed only). Unstated shipping is flagged `SHIPPING_NOT_STATED` |
| C. Coupon price       | B − best **VERIFIED** coupon                                                                                          |
| D. Bank-offer price   | B − best **VERIFIED** bank offer the user is eligible for                                                             |
| G. Membership price   | B − best **VERIFIED** benefit of a membership the user stated                                                         |
| Best verified payable | the lowest of B, C, D, G. Benefits are **never stacked**: combinability is rarely stated and never assumed            |
| E. Cashback           | verified cashback shown separately. "After cashback" is a reference value, **not a payable price**                    |
| F. Exchange           | largest stated exchange benefit, shown separately and **never** used in ranking                                       |
| H. EMI                | per plan: installment, interest, processing fee, total payable and extra cost                                         |

Percentage benefits and minimum-transaction checks use the selling price (the
order value); deductions apply to the delivered price. A benefit is capped at
its stated maximum and at the transaction value.

### Conditional benefits

Each benefit records:

- type, amount or percentage, maximum, minimum transaction;
- eligible banks, payment methods and card types, membership;
- coupon code, validity window, conditions and terms;
- whether the source verified it, and the computed value, status and reasons.

| Status       | Rule                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPIRED`    | past `expiresAt`                                                                                                                                                                                                                                                                                        |
| `INELIGIBLE` | a stated requirement is known to be unmet: minimum transaction, the user's bank, card type, payment method or membership, or not yet valid                                                                                                                                                              |
| `UNVERIFIED` | anything not proven:<br>– the source didn't verify it (`verified: false`, the default for listing-page promotions);<br>– the amount isn't stated;<br>– a bank offer doesn't name its banks;<br>– the **user's eligibility is unknown**;<br>– free-text conditions can't be evaluated;<br>– type `OTHER` |
| `VERIFIED`   | source-verified, and every requirement checked and met                                                                                                                                                                                                                                                  |

**Only VERIFIED coupon, bank and membership benefits reduce a price.** The
user's eligibility (`banks`, `cardTypes`, `paymentMethods`, `memberships`) is
only what the user stated. A missing key means unknown, never "eligible".
Bank names are compared loosely (`HDFC` ≡ `HDFC Bank Ltd.`).

### EMI

- Costs are computed only from what the source states:
  - the monthly installment (total = installment × tenure + fee);
  - the total interest;
  - an explicit no-cost claim. Interest is waived as claimed, fees still count, and the plan is flagged `NO_COST_CLAIM_UNVERIFIED`.
- A bare interest rate is **not** turned into an estimate: the label is `COST_NOT_STATED`.
- Labels: `NO_EXTRA_COST`, `COSTS_MORE` (never presented as a discount), `COST_NOT_STATED`, `INCONSISTENT` (installments add up to less than the price).
- A "no-cost" plan with fees is flagged `NO_COST_CLAIM_HAS_CHARGES`.

## Historical price intelligence

These stats come from one offer's snapshots, i.e. one marketplace listing:

- 7/30/90/180-day lowest (with its date), highest and average;
- observation count and **coverage**;
- historical average, previous distinct price and the change from it;
- change vs the 30-day average, and the trend (FALLING / RISING / STABLE / INSUFFICIENT_DATA, at ±3%);
- a verified recent drop.

**Coverage.** A snapshot tells the price until the next snapshot, but for at
most 48 hours. Time beyond that is missing data. Each window reports the share
of it that was actually observed.

**Claims.** Shown wording is exactly:

| Claim                                                    | Requires                                                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| "Lowest observed price in the last N days"               | current ≤ every observation in the window, and ≥ 90% of the window observed (the longest such window is used)                    |
| "Lowest price observed on this marketplace since launch" | a known launch date, observation starting within 7 days of launch, gap-free coverage since then, and current ≤ every observation |
| nothing                                                  | otherwise                                                                                                                        |

DealMind never says "all-time low" without that evidence, and even then only
per marketplace: other marketplaces weren't observed by this offer.

**Verified recent drop.** The current price is compared with the median of the
30 days before that price began. The reference must have held for at least 2
observations over at least 3 days, so a one-off price spike can't manufacture
a "drop".

**Genuine discount** (from Phase 3.1, unchanged) compares the price with the
offer's own 90-day median. It needs at least 5 points over at least 14 days;
otherwise the verdict is INSUFFICIENT_HISTORY.

## Ranking

Pipeline:

1. **Hard filters.** These are never relaxed, and every exclusion is reported with a reason:
   - **Always:** out of stock (`UNAVAILABLE`), observed more than 24 h ago (`STALE_PRICE`, configurable), indicative price.
   - **Category:** any slug on the product's category path.
   - **Budget:** on the ranking price.
   - **Brand:** include or exclude.
   - **Required / excluded specs:** a required spec the listing doesn't state is `SPEC_NOT_STATED`, not assumed.
   - **Ids:** variant ids, excluded product or offer ids.
   - **Sources:** include or exclude.
2. **Score components** (integers 0–10000; `null` means no data and is excluded from weighting, never guessed):

   | Component   | Definition                                                                                                                                                                                                    |
   | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `price`     | relative to the cheapest offer in the set: 10000 − 4 × (bp above cheapest), so 25% more expensive scores 0. Relative rather than min-max, so a ₹500 gap isn't scored like a ₹5,000 gap                        |
   | `discount`  | verified direct discount: 2 × % (50% off = full score), only from a valid MRP. Scaled by the history verdict: GENUINE ×1, INSUFFICIENT_HISTORY ×¾, NOT_GENUINE ×½ (an MRP "discount" the history contradicts) |
   | `history`   | position in the 90-day observed range (lowest = 10000). Needs ≥ 3 observations and ≥ 50% coverage                                                                                                             |
   | `specMatch` | share of the user's preferred specs the listing states and matches                                                                                                                                            |
   | `relevance` | share of query tokens in the title                                                                                                                                                                            |
   | `quality`   | only from a trustworthy source passed explicitly (`qualityBp`). **None exists yet**, so it is always null                                                                                                     |
   | `recency`   | 10000 at launch, linearly down to 0 at 365 days                                                                                                                                                               |
   | `priceDrop` | 5 × verified drop % (20% drop = full score)                                                                                                                                                                   |

3. **Mode strategy.** Confirmed-available offers (IN_STOCK / LIMITED) always rank before PREORDER / UNKNOWN. Those are flagged `availabilityConfirmed: false`. Ties break on ranking price, then offer id, so output is deterministic.

| Mode                                 | Order                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lowest_price` (alias `cheapest`)    | ranking price ascending                                                                                                                                                                     |
| `highest_discount`                   | discount score, then direct % and amount. Offers without a valid MRP come last (warning `NO_VERIFIABLE_MRP`)                                                                                |
| `best_value`                         | weighted mean: **price 35, specMatch 20, discount 15, history 15, relevance 15, quality 10**. Weights are renormalized over the components that have data, and are configurable per request |
| `recently_launched` (alias `newest`) | recency 60 + price 40. Unknown launch dates come last (warning `LAUNCH_DATE_UNKNOWN`)                                                                                                       |
| `price_drop`                         | verified drop, then drop amount                                                                                                                                                             |
| `trending_deals`                     | **No trustworthy demand or popularity data is collected**, so it falls back to best_value with warning `TRENDING_DATA_UNAVAILABLE` (`appliedMode` says so)                                  |
| `relevance`                          | query match                                                                                                                                                                                 |

**Price basis.** Ranking uses the delivered price by default.
`priceBasis: "best_verified"` uses the best verified payable price instead,
which only differs when verified, eligible benefits exist. The agent selects it
only when the user stated eligibility.

**Affiliate neutrality.** `RankCandidate` has no affiliate, commission or
revenue field, and the request schema is strict. A test attaches commission
data to candidates and asserts identical ranks and scores in every mode.

**Explanations** are built only from the data that produced the rank. Each
ranked deal has:

- `summary`;
- `factors`:
  - delivered-price composition;
  - discount vs MRP;
  - history claim;
  - recent drop;
  - each benefit with its status ("not applied: not verified", "credited later, not deducted");
  - availability;
  - observation time.
- `versusNext`: the deciding difference against the next deal, e.g. "₹260 lower delivered price than #2 (Store C)".

## Recommendations

`recommend(candidates)` (`packages/intelligence/src/ranking/recommend.ts`) picks four labels using the ranking engine itself, so its hard filters apply: stale, out-of-stock and indicative-price offers are never recommended, and excluded offers are counted by reason.

| Label                            | How it is picked                                                                                            | Reasons shown                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Lowest delivered price           | `lowest_price` rank 1                                                                                       | Delivered price and composition; the gap to the next cheapest                              |
| Highest verified direct discount | First `highest_discount` offer with a discount from a valid stated MRP                                      | % off the MRP; whether price history confirms it (genuine / MRP-only / not enough history) |
| Best value                       | `best_value` rank 1                                                                                         | Score out of 10,000 and the engine's top factors                                           |
| Best historical price position   | Highest history component (position in the offer's own 90-day range; needs ≥ 3 observations covering ≥ 50%) | The lowest-observed claim or range position, vs the 30-day average, and coverage           |

- **When nothing qualifies,** the label says why (for example "No current offer has a discount from a valid, stated MRP"). Nothing is substituted.
- **No affiliate or commission input exists** in this module.
- **Where it's used:**
  - `GET /products/:id/pricing` across one variant's marketplaces;
  - `GET /compare` across picked variants.

## Internal API (service token, `/internal/v1`)

| Endpoint                                     | Body / result                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /intelligence/pricing/calculate`       | `{ offerId, eligibility? }` → `{ offer }`: offer facts and the full pricing result. 404 if unknown                                                                                                                                   |
| `POST /intelligence/pricing/batch`           | `{ offerIds (≤400), eligibility? }` → `{ offers, unknownOfferIds }`                                                                                                                                                                  |
| `GET /intelligence/pricing/history/:offerId` | `?days=7..180` → `{ stats, series }`                                                                                                                                                                                                 |
| `POST /intelligence/ranking/rank`            | `{ offerIds, mode, query?, filters?, preferredSpecs?, priceBasis?, weights?, maxPriceAgeHours?, recentlyLaunchedDays?, eligibility? }` → ranked deals (each with offer facts), exclusions, warnings, weights and a **ranking token** |
| `POST /intelligence/ranking/compare`         | `{ offerIds (2–20), eligibility? }` → side-by-side prices, cheapest delivered / verified payable, highest discount, same-variant check                                                                                               |

- Requests are strict Zod.
- Responses are validated by Zod response schemas (`pricing/schemas/results.ts`): every `…Paise` field must be a safe integer, and every status must be known.
- The Phase 3.1 routes `POST /intelligence/pricing` and `POST /intelligence/rank` were **removed**. Their only consumer, the agent, uses the routes above.

### Ranking provenance

`ranking/rank` returns a token signed with a key derived from
`SESSION_SECRET`, which only the API holds; the agent doesn't have it.
`PUT /searches/:id/agent-result` rejects ranked deals (422) unless they are
exactly a prefix of a signed ranking: same offers, ranks and scores.

So the agent cannot forge, reorder or rescore results. Prices at search time
are still read from the database.

## Python agent

| Node                  | What it does                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calculate_discounts` | calls `pricing/batch`, passing the user's stated eligibility                                                                                                   |
| `rank_deals`          | calls `ranking/rank`, passing the hard filters (budget, brands, specs, sources, category), the eligibility and `priceBasis` (only when eligibility was stated) |
| `save_results`        | persists the engine's own ranks, scores and explanation with the token                                                                                         |

- Intent extraction now captures only **stated** banks, card types and memberships (`payment_banks`, `card_types`, `memberships`).
- New sort modes: `lowest_price`, `recently_launched`, `price_drop`, `trending_deals`. The old names are still accepted.

## Tests

| Suite                                          | Count | Covers                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricing/test/pricing-engine.test.ts`          | 26    | categories 1–12, 19, 20: direct discount, missing MRP, invalid prices, shipping and fees, coupon / bank / membership eligibility, cashback separation, exchange exclusion, EMI transparency, historical lowest, missing history, BigInt exactness, rounding and boundaries |
| `ranking/test/ranking.test.ts`                 | 14    | categories 13–18: lowest price (incl. the verified-payable basis), highest discount (incl. an inflated MRP), best value, hard filters, recently launched, price drop, unavailable and stale exclusion, affiliate neutrality, explanations, determinism, comparison         |
| `apps/api/src/test/pricing.db.test.ts`         | 8     | the endpoints on PostgreSQL: auth, 404, eligibility, history wording, filters, exclusions, token, compare, strict schemas                                                                                                                                                  |
| `apps/api/src/test/internal.db.test.ts`        | —     | updated: forged, reordered and unsigned rankings are refused at persistence                                                                                                                                                                                                |
| `apps/agent/tests/test_pricing_integration.py` | 5     | stated-only eligibility, filters passed unchanged, trending warning, chunking                                                                                                                                                                                              |

- Fixtures use realistic Indian price levels (₹499 to ₹29,999, ₹3 platform fee, ₹199 EMI fee, 10% bank offer capped at ₹1,500) with fictional products.
- Mutation-checked: letting UNVERIFIED benefits reduce the price fails 2 tests.

## Benchmarks

`pnpm --filter @dealmind/intelligence bench:pricing [-- --offers 400 --snapshots 180]`

Synthetic data, disposable `*_pricing_bench_test` database. Measured on the
development machine (Windows 11, PostgreSQL 17 in Docker Desktop, Node 24),
400 offers × 180 daily snapshots, each offer with a coupon, bank offer,
cashback, EMI plan and fee:

| Measure                                                                 | Result                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `calculatePricing` (pure)                                               | 0.13 ms p50 / 0.34 ms p95 per offer, about 4,900 offers/s |
| `rankOffers`, 400 candidates                                            | 3.6–4.9 ms per call (every mode)                          |
| `PricingService.candidates`, 400 offers from the DB (= `pricing/batch`) | 642 ms p50, 709 ms max (loads 72,000 snapshot rows)       |
| `rank`, 100 offers from the DB                                          | 170 ms                                                    |

## Limitations

- **No benefit is VERIFIED today.** No connector can verify offers yet:
  - Amazon and Flipkart aren't authorized (see CONNECTORS.md);
  - listing-page promotions default to `verified: false`;
  - only a checkout/cart quote API could set `verified: true`.

  So coupon, bank and membership prices stay null, and rankings use delivered prices. This is the honest outcome, not a bug.

- **No quality or popularity data.** `quality` is unused and `trending_deals` falls back to best_value. DealMind collects no ratings or demand data and won't invent them.
- **History is per offer (marketplace listing).** There is no cross-marketplace "lowest ever" for a product.
- **Snapshots only exist while an offer is observed.** Untracked periods are gaps and lower coverage, so claims become rarer until price tracking (Phase 7) observes offers regularly.
- **Batch pricing from the DB loads raw snapshots** (about 640 ms for 400 offers × 180 days). SQL-side window aggregation would be the next optimization if this becomes a bottleneck.
- **Benefit stacking is never applied**, even when a marketplace allows it. That understates savings rather than overstating them.
- **`best_value` weights are reasoned defaults**, documented and configurable per request, not tuned on user outcomes.
