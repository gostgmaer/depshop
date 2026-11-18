# Deal ranking and price intelligence evaluation

The pricing (`packages/intelligence/src/pricing`) and ranking (`…/ranking`) engines are deterministic TypeScript. The LLM never computes a price, discount or rank. Background: [PRICING.md](PRICING.md).

**Status 2026-11-18: no change made in Prompt 24.** There is no real price history: every real marketplace is pending authorization, so no ranking decision can be evaluated against real outcomes. Below is the capability inventory and what is measured on synthetic fixtures.

## Ranking modes

| Requested mode                                                | Engine                                                | Status                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Highest genuine discount                                      | `highest_discount` (+ `genuine_discount_only` filter) | Implemented; a discount is "genuine" only with enough history (`GENUINE` verdict)                                                          |
| Lowest final price                                            | `lowest_price` (delivered price by default)           | Implemented                                                                                                                                |
| Best overall value                                            | `best_value` (weighted, explainable components)       | Implemented                                                                                                                                |
| Recently launched                                             | `recently_launched`                                   | Implemented; unknown launch dates are warned about, never assumed                                                                          |
| Biggest verified price drop                                   | `price_drop` (verified drop vs. a reference price)    | Implemented; a one-off spike can't manufacture a drop (tested)                                                                             |
| Historical price opportunity (current vs. historical average) | —                                                     | **Not a mode.** The data exists (`historicalAveragePaise`, window lows); **recommended** once real history exists to validate it           |
| Trending deals                                                | `trending_deals`                                      | **Deliberately refused:** no trustworthy demand data exists, so it falls back to `best_value` with the warning `TRENDING_DATA_UNAVAILABLE` |

Affiliate commission is not an input to any mode (engine inputs carry no affiliate data; `ranking.test.ts` § "affiliate-neutral ranking").

## Price intelligence

| Requested signal                            | Status                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Historical min and max; current vs. average | Implemented per window: `lowestPaise`, `highestPaise`, `averagePaise`, `currentIsLowest`                                              |
| 7, 30 and 90-day movement                   | Implemented: windows `[7, 30, 90, 180]` days, `trend` (FALLING/RISING/STABLE/INSUFFICIENT_DATA), `changeFromPreviousBp`, `recentDrop` |
| "Lowest price" claims                       | Only for a window actually observed (≥ 90 % coverage); all-time low only with full coverage since launch                              |
| Offer freshness                             | Implemented: offers older than `maxPriceAgeHours` (24 h) are excluded from ranking, and stale offers are labelled "Not current"       |
| Price volatility                            | **Not implemented.** Recommended (stddev over the window, in bp) once real series exist to set thresholds                             |
| Seller reliability                          | **Not implemented, and must not be invented:** no trustworthy seller data is collected. **BLOCKED** until a partner API supplies it   |

**Kept separate in every price breakdown (implemented and tested):**

- MRP;
- selling price;
- shipping and mandatory fees (delivered price);
- coupons (only verified, eligible, unexpired);
- bank offers (only for a user-stated bank and card type);
- cashback (shown, never deducted);
- exchange (listed, never deducted);
- membership (only for a stated member);
- EMI (interest shown, never a discount).

## Measured (synthetic fixtures, not production)

The intelligence suites (53 unit + 26 DB tests) all pass. They are correctness checks on constructed cases, **not quality measurements**: they prove that the rules hold (no fabricated discount, no lowest claim without coverage), not that the ranking order is the one shoppers prefer.

## How to evaluate ranking once data exists

1. Collect search sessions where a user opened or clicked a result. Use the aggregate-only position-of-first-click per mode; no personal history.
2. Compare modes and weight changes offline on the same stored candidates. The engine is deterministic, so reruns are exact.
3. Ship weight changes behind a per-mode configuration with a before-and-after report. Never change ranking silently.
