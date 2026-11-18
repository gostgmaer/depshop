# Marketplace reliability

**Status 2026-11-18: no real marketplace has ever been called.** Every real source is `PENDING_APPROVAL` (Amazon India, Croma, Reliance Digital, Tata CLiQ) or `PENDING_CREDENTIALS` (Flipkart). There are no production availability, latency or freshness figures, and none is estimated here. Coverage won't improve without authorization; **no scraping will be added to fill the gap.**

## Per-source measurements (instrumented, waiting for real traffic)

| Requested                                | Where                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Availability and health                  | `ShoppingSource.health`, `lastHealthCheckAt`, `lastSuccessAt`; `dealmind_source_up{source,status,health}`                                                      |
| Successful and failed requests, timeouts | Admin → Sources `metrics.requests/failures/timeouts`; `dealmind_connector_requests{source,outcome}`                                                            |
| Latency                                  | `metrics.averageLatencyMs`; `dealmind_connector_latency_ms_avg{source}`                                                                                        |
| Rate-limit events                        | `metrics.rateLimitEvents`                                                                                                                                      |
| Offer count and search runs (30 d)       | `metrics.results`, `searchRuns30d`                                                                                                                             |
| Freshness                                | `ProductOffer.observedAt`, `lastCheckedAt`, `missingSince`; stale offers excluded from ranking after 24 h                                                      |
| Authorization status                     | Readiness: `READY` / `PENDING_CREDENTIALS` / `PENDING_APPROVAL` / `NOT_SUPPORTED`; enabling refused unless `READY` (Prompt 22 fix)                             |
| Data quality                             | **Partly:** schema validation rejects malformed offers (`INVALID`); no per-source quality score yet ([data-quality-governance.md](data-quality-governance.md)) |

## Resilience already implemented

| Mechanism                              | Implementation                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parallel search with failure isolation | `executor.ts`: eligible sources in parallel, bounded concurrency (default 4), all-settled semantics. One failing source never fails the search; the search is marked partial |
| Circuit breaker                        | `retry/circuit-breaker.ts`: per source, CLOSED → OPEN after N consecutive failures → HALF_OPEN probe. Transitions are persisted as source health                             |
| Retries                                | Bounded per source (`maxRetries` 0–5, admin-set), retrying only retryable errors                                                                                             |
| Timeouts and rate limits               | Per source `timeoutMs`, `rateLimitPerMinute` (admin-set, audit-logged)                                                                                                       |
| Response cache                         | Per source `cacheTtlSeconds`; price tracking skips a marketplace call when an offer was observed within the TTL                                                              |
| Honest partial results                 | Skipped and failed sources are listed with reasons in every search; no "all marketplaces" claim                                                                              |

## What to do with real evidence

1. **First week per source:** compare observed latency, rate-limit events and failures with the programme's documented limits. Set `rateLimitPerMinute` below the documented limit and `timeoutMs` to about the p95 plus margin.
2. **Source prioritisation:** only when the evidence shows one source is consistently slower or emptier for a category. Order or skip by measured result rate, never by affiliate commission.
3. **Circuit-breaker thresholds:** tune N and the open period from real failure bursts.

No change to any of these was made in Prompt 24: there's nothing real to tune against.
