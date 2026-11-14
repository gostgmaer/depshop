# Marketplace connectors (Phase 2.3)

`packages/connectors` (`@dealmind/connectors`) searches every eligible,
enabled shopping source in parallel. It validates and normalizes their
responses and reports every source's outcome honestly. It is independent of
LangGraph: the AI layer (Phase 5) will call it through application services
(the worker's search processor today), and connectors never import LangGraph,
Prisma or Redis.

```text
packages/connectors/src/
├── core/
│   ├── interfaces/    ShoppingConnector contract
│   ├── types/         Zod schemas (request, capabilities, product/offer, health), error categories
│   ├── registry/      ConnectorRegistry, SourceConfig (ShoppingSource-backed), effective status
│   ├── executor/      ParallelSearchExecutor, bounded pool, response validation
│   ├── rate-limiter/  Redis (shared) + memory limiters
│   ├── retry/         exponential backoff + full jitter, circuit breakers
│   ├── cache/         query normalization, response cache (Redis/memory), single-flight
│   ├── health/        HealthMonitor, metrics (Redis store + OpenTelemetry instruments)
│   └── normalizers/   rupees → paise, offer conditions, → catalog SourceListing
├── amazon/  flipkart/  croma/  reliance/  tatacliq/  web-discovery/
└── mock/              MockConnector (fictional), ScriptedConnector (test double), seedMockSources
```

## Integration status (2026-11-15)

| Source                  | Connector                                                             | Status                                                        | What is needed                                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amazon India            | `AmazonCreatorsConnector` (no network client)                         | **Awaiting approval** (`PENDING_APPROVAL`)                    | An approved Amazon.in Associates account and Creators API credentials (OAuth2 client credentials, scope `creatorsapi::default`). Then verify the regional token endpoint, the India `x-marketplace` value and the OffersV2 schema in the authenticated docs, and implement the client. PA-API 5.0 is deprecated and not used. |
| Flipkart                | `FlipkartConnector`: Affiliate API 1.0 search, product lookup, health | **Implemented, awaiting credentials** (`PENDING_CREDENTIALS`) | `FLIPKART_AFFILIATE_ID` and `FLIPKART_AFFILIATE_TOKEN` from an approved affiliate account. Then run `pnpm --filter @dealmind/connectors build && pnpm --filter @dealmind/connectors verify:flipkart`, and only then set the source to `ACTIVE`. It is built from the published docs but has **never been called live**.       |
| Croma                   | `PartnerPendingConnector`                                             | **Awaiting approval**                                         | No public product API or feed was found. Needs a partner/feed agreement.                                                                                                                                                                                                                                                      |
| Reliance Digital        | `PartnerPendingConnector`                                             | **Awaiting approval**                                         | No public product API or feed was found. Needs a partner/feed agreement.                                                                                                                                                                                                                                                      |
| Tata CLiQ               | `PartnerPendingConnector`                                             | **Awaiting approval**                                         | Affiliate networks provide tracking links only. Needs a partner/feed agreement.                                                                                                                                                                                                                                               |
| Web discovery           | `WebDiscoveryConnector` + `DiscoveryProvider` interface               | **Not currently supported** (no provider)                     | An authorized search provider or licensed feed. Discovery prices are `INDICATIVE` and are never stored as offers.                                                                                                                                                                                                             |
| Mock Store Alpha / Beta | `MockConnector`                                                       | **Mock only** (fictional data)                                | Dev/test only. They are registered outside production, refused in production, and their sources are flagged `isSample`.                                                                                                                                                                                                       |

**Fully implemented and verified against a live marketplace: none.**
Nothing is scraped. No CAPTCHA, login or anti-bot measure is bypassed. No endpoint or credential has been invented.

**Sources consulted (2026-11):**

- Amazon Associates, [Creators API migration guide (amazon.in)](https://affiliate-program.amazon.in/creatorsapi/docs/en-us/migrating-to-creatorsapi-from-paapi) and [PA-API 5 deprecation](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation).
- Flipkart, [Affiliate API product reference](https://affiliate.flipkart.com/api-docs/af_prod_ref.html), [FAQ](https://affiliate.flipkart.com/api-docs/af_faq.html) and [API terms of use](https://affiliate.flipkart.com/api-docs/af_tou.html).
- For Croma, Reliance Digital and Tata CLiQ, only third-party affiliate-network listings were found (for example Cuelinks and INRDeals), with no merchant API docs.

## Statuses

`ShoppingSource.status` is the admin/integration status. It defaults to
`DISABLED` and can be `ACTIVE`, `PENDING_CREDENTIALS`, `PENDING_APPROVAL` or
`MAINTENANCE`, and `statusReason` says why. Runtime health (`health`,
`lastHealthError`, `lastHealthCheckAt`, `lastSuccessAt`) is written by the
health monitor and the circuit breakers. The API reports the combination as
`connectorStatus`:

| status                                   | health     | connectorStatus |
| ---------------------------------------- | ---------- | --------------- |
| `PENDING_CREDENTIALS`/`PENDING_APPROVAL` | any        | same            |
| `DISABLED`/`MAINTENANCE`                 | any        | `DISABLED`      |
| `ACTIVE`                                 | `DOWN`     | `FAILED`        |
| `ACTIVE`                                 | `DEGRADED` | `DEGRADED`      |
| `ACTIVE`                                 | other      | `ACTIVE`        |

A source takes part in live search only when all of these hold:

- its status is `ACTIVE`;
- a connector is registered for its slug and not switched off in the registry;
- the connector reports itself `READY` (credentials present, approval done);
- it declares the `search` capability and the requested category;
- it is not a mock, unless mocks are allowed;
- its circuit isn't open.

`DEGRADED` sources still participate (deliberately), because their circuit
breaker protects searches. Every other source gets a `SKIPPED` run with the
reason, such as `SOURCE_NOT_ACTIVE`, `NOT_CONFIGURED`, `PENDING_APPROVAL` or
`MOCK_NOT_ALLOWED`.

Credentials are only ever environment variables of the worker. They are never
stored in the database, logged (pino redaction) or returned by the API.

## Execution (ParallelSearchExecutor)

For each eligible source, in a bounded pool (`CONNECTOR_CONCURRENCY`, default 6):

1. **Circuit breaker** (per source, per process). It opens after
   `circuitFailureThreshold` consecutive failures and rejects calls with
   `CIRCUIT_OPEN` for `circuitOpenSeconds`. Then a single half-open probe runs:
   success closes the circuit, failure re-opens it. Transitions are persisted
   as health `DOWN`/`HEALTHY`.
2. **Response cache.** It is keyed by source plus a fingerprint of the
   normalized request: NFKC, lower-case, collapsed spaces, sorted brands,
   price range and limit. The TTL is `ShoppingSource.cacheTtlSeconds`, and
   `invalidateSource()` clears a source. Keys never contain user ids, so cached
   data is shared marketplace data, not anyone's search history.
3. **Single-flight.** Identical concurrent requests share one upstream call.
4. **Rate limit.** A Redis fixed window per minute, shared by all processes,
   with the limit set by `rateLimitPerMinute`. A call waits for the window if
   the wait fits both `maxRateLimitWaitMs` and the source's budget; otherwise
   it fails `RATE_LIMITED`. Our own limiter never trips the circuit. It fails
   closed if Redis is down, so no marketplace limit is ever risked.
5. **Retries.** Retryable categories (`TIMEOUT`, `RATE_LIMITED`, `UPSTREAM`,
   `NETWORK`) are retried with exponential backoff and full jitter, up to
   `maxRetries`, within the source budget. Other categories (`AUTH`,
   `INVALID_RESPONSE`, …) are never retried.
6. **Timeout.** Each attempt gets `timeoutMs`. An `AbortSignal` is passed to
   the connector, and the attempt is also raced against a timer, so a
   connector that ignores the signal still times out.
7. **Validation.** A malformed envelope, or one claiming another source, is
   `INVALID_RESPONSE`. Each item is validated individually; invalid items are
   dropped and counted (`rejectedItems`), never passed on.

Per source the executor records the status, duration, attempts, result count,
cached and deduplicated flags, and the error category. Failures are isolated:
the executor never rejects because of one source. The overall status is:

- `COMPLETED`: every searched source succeeded;
- `PARTIAL`: some failed, but results from the others are kept;
- `FAILED`: all failed;
- `NO_SOURCES`: nothing was eligible. The worker stores this as a `COMPLETED` search with zero results.

## Normalization

The connector boundary schema is `normalizedProductSchema`. It holds:

- source id, external id, title, brand, product URL (http/https only), optional image, category path, model number and barcode;
- price fields in integer paise: `sellingPricePaise`, `mrpPaise`, `shippingPaise`. Rupee amounts are converted exactly by the shared string parser;
- currency `INR`, seller, stock status;
- product attributes, plus variant attributes and SKU;
- promotions;
- source update time, observation time and provenance (method, provider, operation, retrieval time).

`priceType` describes the price itself:

- `LISTED`: the listing price at observation time.
- `VERIFIED_CHECKOUT`: a price confirmed by a checkout quote. No connector provides this yet.
- `INDICATIVE`: allowed only for discovery provenance. These prices are never stored as offers.

**Conditional benefits are never mixed with direct discounts.** Coupons, bank
offers, cashback, exchange and membership offers go into
`ProductOffer.offerConditions` (`{priceType, coupons, bankOffers, cashback,
exchange, membership, other, provenance}`). The selling price is never reduced
by them. The worker maps items through `toSourceListing` into the catalog
importer (see [CATALOG.md](CATALOG.md)), which matches them, upserts offers
and appends price history.

## Observability

- **Pino logs:** search summaries, retries, circuit transitions, per-source failures and health reports, with credentials redacted.
- **OpenTelemetry:** an API span `connector.search <source>` per source, and the metrics `dealmind.connector.requests`, `.errors`, `.duration` (ms) and `.results`. They are no-ops until the host installs an OTel SDK (Phase 11).
- **Queryable metrics:** stored in the Redis hash `<prefix>:connectors:metrics:<source>`. They cover requests, successes, failures, timeouts, rate-limit events, cache hits, results, average latency, errors by category and last success/failure. They are written by the worker and read by the API.
- **Health:** the `connector-health` BullMQ job scheduler runs every `CONNECTOR_HEALTH_INTERVAL_SECONDS` (default 300). An unconfigured source that an admin set `ACTIVE` becomes `FAILED` with the missing variable names, and no network call is made.

**API (public, no secrets):**

- `GET /api/v1/sources`: every source with `connectorStatus`, `statusReason`, health and last success.
- `GET /api/v1/sources/:id`: by uuid or slug, adding tuning, capabilities and metrics.
- `GET /api/v1/sources/status`: a summary.

## Local development

```bash
pnpm --filter @dealmind/connectors build
# Mock stores (fictional data) for local search, dev only:
node -e 'import("@dealmind/connectors").then(async ({seedMockSources}) => { const {createPrismaClient} = await import("@dealmind/db"); const p = createPrismaClient(); await seedMockSources(p); await p.$disconnect(); })'
pnpm --filter @dealmind/worker dev     # mocks are on outside production (CONNECTORS_ENABLE_MOCKS)
```

## Adding a marketplace

1. Implement `ShoppingConnector` in its own folder. Use only documented, authorized operations, map responses to `NormalizedProductInput`, map HTTP failures with `ConnectorError.fromHttpStatus`, and never include credentials in errors.
2. Register it in `createDefaultRegistry`, reading credentials from env.
3. Add or seed its `ShoppingSource` row with a pending status and a reason.
4. Write tests from the documented response shape, then verify against the live API with real credentials before setting the source `ACTIVE`.
