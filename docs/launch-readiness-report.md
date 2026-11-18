# DealMind AI — launch readiness report (Prompt 22)

**Date:** 2026-11-18.

**Method:** inspection of the repository, every automated suite executed, a new **full-stack journey** against real processes, and a local **staging release simulation** using the production images and compose stack. No real staging or production infrastructure, credentials or provider approvals were available; nothing was deployed anywhere. All results below were actually run; nothing is extrapolated.

## Release decision: **READY FOR STAGING ONLY**

The product works end to end as one system: account, search, comparison, tracking and alerts, notifications, sandbox billing, admin, isolation, and deletion. The deployment and recovery path also works with the production images. Production gates remain, and none can be closed from this repository:

- a real staging and production host;
- the shared IAM, payment (Razorpay), e-mail and LLM accounts;
- marketplace and affiliate approvals. Without them, **no real marketplace can be searched**; every real source is correctly `PENDING_*`.
- the operator's privacy and legal details;
- an alert receiver.

## A. Architecture

### Verified components and dependency map

```
apps/web (Next.js) ──/api proxy──▶ apps/api (Fastify) ──Prisma──▶ PostgreSQL
                                     │  ├─ BullMQ (Redis) ──▶ apps/worker ──HTTP+token──▶ apps/agent (FastAPI/LangGraph)
                                     │  │                        │                              │
                                     │  │                        └─ tracking, alerts, notifications, billing reconcile
                                     │  └─ /internal/v1 ◀── HTTP + token + HMAC user context ──┘ (agent → connectors, intelligence)
                                     └─ shared EasyDev IAM, payments, notifications (HTTP)
```

The workspace package graph (from `package.json`, verified) is layered, with **no package-level cycles** and **no module-level runtime import cycles**. The latter was checked with a dependency-free import-graph scan of every TS source tree.

| Package                  | Depends on                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------- |
| api                      | affiliate, billing, catalog, connectors, db, intelligence, notifications, queue, shared |
| worker                   | affiliate, billing, catalog, connectors, db, notifications, queue, shared               |
| web                      | shared                                                                                  |
| intelligence             | catalog, db, shared                                                                     |
| connectors               | catalog, db, shared                                                                     |
| billing                  | db, notifications, shared                                                               |
| affiliate, notifications | db, shared                                                                              |
| db                       | shared                                                                                  |
| catalog, queue, shared   | none                                                                                    |

### Agent workflow (verified in code and in the journey)

`intent_extractor → query_validator → search_planner → source_discovery → parallel_search → normalize_products → deduplicate → apply_filters → calculate_discounts → rank_deals → evaluate_results → generate_response → save_results`

There are conditional exits for clarification and for empty results. The LLM is used only to extract intent and to narrate. The narration is validated against the facts: new numbers or URLs are rejected. Discounts and ranking are computed by the deterministic TypeScript services through `/internal/v1`.

### Consistency checks

- **Environment variables:** every variable the production compose file passes to the API, worker, agent and web is read by that service. Optional tuning variables were missing from the env template; they are now documented.
- **Contracts:** API responses are Zod-serialised. The admin and test fixtures are checked against the shared contracts.
- **Dependencies:** unused dependencies were removed: `@radix-ui/react-popover`, `@radix-ui/react-select` and `framer-motion` (web), and `@dealmind/db` and `@dealmind/shared` (catalog).

## B. Functional validation: the full-stack journey

`pnpm --filter @dealmind/api test:journey` runs:

- the real API over HTTP (fake IAM only, because the shared IAM can't run locally);
- the **built worker process**;
- the **Python agent process** (rules LLM, deterministic);
- PostgreSQL and Redis;
- mock connectors (fictional data, refused in production);
- the sandbox payment provider.

**Result: 8 of 8 steps passed.** Evidence is written to `load/results/journey.json`.

| Step                                                                                                                                 | Observed                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Account lifecycle                                                                                                                 | register, verify e-mail, login, session, logout (then 401), forgot and reset password, re-login.                                                                                                                                                                                                                                                                                                                |
| B. Realistic query: _"Find a newly launched smartphone under ₹35,000 with 8GB RAM, 256GB storage and the highest genuine discount."_ | Intent: smartphones, ≤ ₹35,000 (3,500,000 paise), RAM 8 GB, storage 256 GB, recently launched, highest discount, genuine-only. 2 mock sources searched; 5 real sources **SKIPPED with their reason** (`PENDING_APPROVAL` ×4, `PENDING_CREDENTIALS` ×1). **0 results**, with _"No offer has enough price history to verify a genuine discount yet"_. That is correct: nothing is invented. It finished in 1.1 s. |
| B. Control query (no launch or genuine requirement)                                                                                  | 2 offers of the fictional 8 GB/256 GB phone. Prices equal the stored offers (₹20,369.03 and ₹20,999.00; MRP ₹26,999 kept separate). Mock URLs labelled as mock in the summary.                                                                                                                                                                                                                                  |
| C. Comparison                                                                                                                        | Offers (4 across 2 variants and 2 sources), pricing, price history and compare all 200.                                                                                                                                                                                                                                                                                                                         |
| D/E. Watchlist + alerts → simulated price drop                                                                                       | Watchlist created and renamed. Two users' alerts on the same variant. **One** shared marketplace check (`PRICE_DECREASED`) notified **both** users, in 8.2 s. A later scheduled run made **no** extra marketplace request and produced **no** duplicate notification. Unread count went 3 → 2 after mark-read.                                                                                                  |
| F. Billing                                                                                                                           | FREE → PRO through sandbox checkout and confirm; provider `sandbox`; usage endpoint OK.                                                                                                                                                                                                                                                                                                                         |
| H. ADMIN                                                                                                                             | All 9 admin areas return 200 for an ADMIN, 403 for a USER. Connector readiness is reported honestly (after the fix below).                                                                                                                                                                                                                                                                                      |
| I. Isolation                                                                                                                         | User B on user A's search, results, alert (read and change), watchlist (read and rename), notification (read and delete): **all 404**. B sees only B's searches; B's plan is still FREE.                                                                                                                                                                                                                        |
| K. Deletion                                                                                                                          | Account deleted (paid plan cancelled first); shared catalog unchanged (1 product, 4 offers, 6 price snapshots); the other user's alert kept.                                                                                                                                                                                                                                                                    |

**Not covered by automation:**

- **E-mail and web-push delivery:** the notification service and VAPID are not configured locally. In-app delivery is verified; e-mail and push deliveries are recorded as skipped.
- **A browser driving the real API:** the Playwright suite uses a mock API. The journey covers the same flows at the API level.

## C. Security

- **Isolation and authorization:**
  - the journey (above);
  - `security.db.test.ts` (sessions, push subscriptions, mass assignment, forged headers, client-supplied owner ids);
  - per-feature isolation suites;
  - admin suites (401/403 before validation on every endpoint).
- **Defects found and fixed in this audit:**

| ID    | Sev.   | Defect                                                                                                                                                                                                                                                             | Fix and evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P22-1 | **P1** | **Redis would not start**: crash loop. The Phase 7.1 `rename-command FLUSHDB ""` broke replay of an append-only file that had recorded a `FLUSHDB`. The dev Redis was found crash-looping after a restart, and production could hit this with any migrated volume. | Dangerous commands are now **denied by an ACL**: `-flushall -flushdb -config -module -debug`. ACLs apply to clients, not to log replay. The password is in a private include file, not on the command line, in both compose files. **Verified:** a read-only copy of the actual crashing data (63 MB, 3 `FLUSHDB`) loads (78 keys); `FLUSHDB` and `CONFIG` are refused; the production stack is healthy with the ACL. |
| P22-2 | **P1** | The admin console reported partner sources with **no authorized integration** (Croma, Reliance Digital, Tata CLiQ: `PENDING_APPROVAL`) as "credentials configured". An admin could **enable** one by first disabling it, then enabling it.                         | Readiness now exposes the connector's real state. A source is "configured" only when its connector is `READY`, and enabling requires `READY`. The UI shows "Awaiting partner approval". Regression test reproduces the disable-then-enable path (409; still DISABLED).                                                                                                                                                |

- **Still open from earlier phases:**
  - DM-19: zod 4 migration (mitigated by body and rate limits).
  - DM-20: Prisma 7 (the CLI only).
  - DM-22: Debian base-image packages with no fixes released (0 _fixable_ criticals).
  - DM-27: RLS deferred (isolation is enforced in three layers).
  - No OWASP ZAP scan or external penetration test.

## D. Quality: tests executed today

| Suite                                                      | Result                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                        | clean                                                                                                                                       |
| `pnpm check --force` (typecheck, lint, unit tests, builds) | 52/52 tasks                                                                                                                                 |
| Unit (Vitest)                                              | api 23, web 122, worker 11, affiliate 7, billing 10, catalog 18, connectors 36, db 5, intelligence 53, notifications 17, queue 5, shared 43 |
| Database / integration                                     | db 68, api 182, worker 43, connectors 6, intelligence 26                                                                                    |
| Agent (pytest, mocked LLM)                                 | 68                                                                                                                                          |
| Playwright (desktop and mobile, axe)                       | 34                                                                                                                                          |
| **Full-stack journey** (new)                               | 8/8                                                                                                                                         |
| Staging simulation (below)                                 | all steps passed                                                                                                                            |
| **Totals**                                                 | **777 tests passed (350 unit + 325 database + 68 agent + 34 Playwright), 0 failed, 0 skipped**, plus 8 journey steps                        |

Coverage percentages were not measured; no coverage tool is installed, and none was added.

**Defects that were the test's own, not the product's** (recorded for honesty):

- The first journey run forced a second price check inside the same due-minute. The scheduler correctly deduplicates that, and a just-observed offer is correctly rescheduled without a marketplace call.
- The journey's report initially read the wrong field names for skip reasons.

## E. Marketplace readiness (actual, from the running system)

| Source            | Status                   | Connector                                                  | Credentials                                                                      | Live?                    |
| ----------------- | ------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------ |
| Amazon India      | `PENDING_APPROVAL`       | Creators API connector implemented                         | missing: `AMAZON_CREATORS_CREDENTIAL_ID/SECRET`, `AMAZON_ASSOCIATES_PARTNER_TAG` | **No**                   |
| Flipkart          | `PENDING_CREDENTIALS`    | Affiliate API connector implemented (documented endpoints) | missing: `FLIPKART_AFFILIATE_ID/TOKEN`                                           | **No**                   |
| Croma             | `PENDING_APPROVAL`       | Placeholder (refuses; no public API used)                  | n/a, needs a partner agreement                                                   | **No**                   |
| Reliance Digital  | `PENDING_APPROVAL`       | Placeholder                                                | n/a, needs a partner agreement                                                   | **No**                   |
| Tata CLiQ         | `PENDING_APPROVAL`       | Placeholder                                                | n/a, needs a partner agreement                                                   | **No**                   |
| Web discovery     | not configured           | Interface only (indicative prices only)                    | needs a licensed provider                                                        | **No**                   |
| Mock Alpha / Beta | `ACTIVE` (dev/test only) | Fictional data; refused when `NODE_ENV=production`         | n/a                                                                              | Mock, not an integration |

No connector has ever been verified against a live partner API. No live verification was possible, and none is claimed.

## F. Deployment readiness

| Gate                                                                                                   | Status                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production images (5)                                                                                  | Built from the current code. In Phase 21: Trivy 0 fixable criticals, non-root.                                                                                                                                             |
| **Staging simulation** (fresh project `dealmind-staging-sim`, production compose + rehearsal override) | **Passed:** env check, pre-migration backup, 17 migrations and seed, roles, all services healthy, smoke 11/11, Redis ACL enforced, backup + restore test (counts matched), second release deployed, rollback to the first. |
| Real staging                                                                                           | **Blocked:** no host or credentials.                                                                                                                                                                                       |
| CI/CD                                                                                                  | Workflows lint clean; **not yet run on GitHub**.                                                                                                                                                                           |
| Monitoring                                                                                             | Overlay verified in Phase 21 (7/7 targets, 23 rules). **No alert receiver.** Sentry and OTel exporters not integrated.                                                                                                     |
| Backup / restore / disaster recovery                                                                   | Verified locally (Phase 21 drill and today's restore test). Timers, `age` encryption and off-host copies are not set up on any host.                                                                                       |

## G. Outstanding issues

- **P0:** none found.
- **P1:** none open. P22-1 and P22-2 are fixed.
  - **Action for you:** your dev Redis container still runs with the old configuration and is crash-looping. Recreate it with `docker compose up -d redis`. I was not permitted to recreate it.
- **P2:**
  - no real browser-driven end-to-end test against the real API (API-level journey only);
  - e-mail and push delivery are unverified without the services;
  - search-keyword normalisation keeps stray punctuation ("…256gb storage .");
  - the open security items above.
- **P3:**
  - genuine-discount queries return nothing until price history accumulates (correct and explained; UX could suggest relaxing the requirement);
  - documentation tidy-ups (done: OTel note, env template).
- **External dependencies and human approvals:**
  - **Hosting and DNS:** a staging and production host, DNS and TLS.
  - **Shared services:** production IAM; e-mail via the notification service (sender domain verified); payments via Razorpay activation in the payment service.
  - **Marketplace and affiliate programmes:** Amazon, Flipkart, Croma, Reliance Digital, Tata CLiQ.
  - **LLM provider:** a production account.
  - **Privacy:** the operator name and contact, and a legal review.
  - **Operations:** an alert receiver, and the GitHub environments with required reviewers.
