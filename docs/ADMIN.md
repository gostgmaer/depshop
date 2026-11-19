# Platform admin console (Phase 6.3)

DealMind is one platform with one set of users. The admin console is for the
platform's own operators (users with role `ADMIN`). It has no tenants,
organizations or memberships.

## Access

- **Web:** the `(admin)` route group at `/admin/*`.
  - The server layout asks the API who the session belongs to (`getServerUser`).
  - Signed-out visitors are redirected to `/login?next=…`.
  - Signed-in non-admins get a **404**, so the area isn't advertised.
  - The shell leaves the area if the session ends or the role is removed.
  - Admins see an "Admin console" item in the account menu.
- **API:** every `/api/v1/admin/*` route checks `app.requireAdmin` in `onRequest`.
  - The check runs before body validation, so non-admins get 401/403 and no schema hints.
  - The role is read from the database through the session. It is never taken from the client.
- **Admin bootstrap (first run):** while no administrator exists, the API keeps a one-time **setup token** (only its SHA-256 is stored, in `PlatformSetup`). It is printed once in the API log at start-up (`First-run setup … setupToken`), or set it yourself with `ADMIN_SETUP_TOKEN`. Open **`/setup`** (the sign-in page links to it while setup is pending), enter the token plus the administrator's name, e-mail and password: the account is registered in the IAM like any sign-up, and **becomes ADMIN at its first sign-in** (audit action `setup.first_admin`). The token is single-use (5 attempts per 15 min per IP); once an ADMIN exists, `/setup` is closed for good. Further admins: `PATCH /api/v1/admin/users/:id/role` by an existing admin. Admins can't change their own role or status. Tests: `setup.db.test.ts` (8), `setup.test.tsx`.

## Rules enforced

| Rule                                           | How                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Never expose secrets**                       | Connector credentials appear only as variable **names** (from `ShoppingConnector.getReadiness()`). LLM, payment and signing keys stay in server environments. Agent health forwards only `status`, `provider` and `model`. Job payloads are never returned (error text only). |
| **Never fabricate analytics or revenue**       | Every figure is a count or sum of stored rows. MRR is labelled an **estimate** from list prices; collected payments, taxes and refunds live in the shared payment service's ledger. Affiliate money is only partner-reported amounts.                                         |
| **Audit every sensitive action**               | `recordAudit`, written after each change, with the actor, target, `requestId`, required `reason`, and `before`/`after` values. Admin console access is recorded at most once per hour per admin (Redis `SET NX EX`).                                                          |
| **No manual payment success**                  | There is no endpoint for it. Subscriptions are read-only mirrors of the payment service.                                                                                                                                                                                      |
| **LLM config can't change pricing or ranking** | The configuration only selects the agent's provider, model, temperature, token limits, fallback and budget. Prices, discounts and ranking are deterministic services.                                                                                                         |
| **No dangerous bulk job operations**           | Only `POST /admin/jobs/:id/retry`: one **failed** job, on an allowlisted queue (not the dead-letter queue), with a reason. Rate-limited to 30 per minute. No retry-all, drain, obliterate or pause.                                                                           |
| **Search privacy**                             | Query lists are k-anonymous: a normalized query appears only if at least **3 distinct users** searched it. Lists never include user ids. Queries are truncated to 120 characters. Per-user detail shows counts, not query text.                                               |

## API (`/api/v1/admin`)

| Method and path                                                | Purpose                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dashboard`                                               | Platform (users, active, new, searches by status, alerts, tracked offers), revenue (estimated MRR, refund events, affiliate approved/pending/reversed/paid), infrastructure (checks, queues, dead letters, connector status). |
| `GET /users?q=&cursor=`                                        | List users. `q` matches email or name, or an exact user id.                                                                                                                                                                   |
| `GET /users/:id`                                               | Profile, sessions, subscription (plan and plan in effect), usage counts, AI tokens in the last 30 days.                                                                                                                       |
| `POST /users/:id/suspend` · `/reactivate` · `/sessions/revoke` | Body `{ reason }`. Refused on yourself. Suspension revokes DealMind sessions; the shared IAM account is not touched.                                                                                                          |
| `GET /sources`                                                 | Sources with credential readiness (names only), health, Redis connector metrics, and 30-day search-run stats.                                                                                                                 |
| `PATCH /sources/:id`                                           | Status (`ACTIVE`/`DISABLED`) and non-secret settings, with a reason. `ACTIVE` needs a registered, configured connector, and is refused for `PENDING_APPROVAL`/`PENDING_CREDENTIALS` sources.                                  |
| `POST /sources/health-check`                                   | Queues one `connector-health` job (unique job id).                                                                                                                                                                            |
| `GET /ai-models` · `PUT /ai-models` · `POST /ai-models/health` | Agent LLM configuration (purpose `INTENT_EXTRACTION`), this month's usage and cost estimate, and agent health.                                                                                                                |
| `GET /analytics?days=`                                         | Search analytics (status mix, success/partial rates, duration, k-anonymous popular and empty-result queries, categories, connector performance, agent runs, daily series in IST).                                             |
| `GET /subscriptions` · `GET /subscriptions/users`              | Plan distribution in effect, status mix, past due, payment failures, estimated MRR, monthly changes, payment-service event counts; paginated paid subscriptions.                                                              |
| `GET /affiliates` (Phase 6.2)                                  | Clicks, partner-reported conversions, payouts, program status.                                                                                                                                                                |
| `GET /jobs` · `POST /jobs/:id/retry`                           | Queue counts and workers, recent failures (10 per queue), dead letters; single-job retry `{ queue, reason }`.                                                                                                                 |
| `GET /system`                                                  | Dependency checks (db, redis, iam, iamJwks, notifications, files, agent, worker, payments; 3 s timeout; `not_configured` when off) and queues.                                                                                |
| `GET /products` · `GET /products/:id` · `PATCH /products/:id`  | Catalog search; detail with variants and offers (provenance read-only); correction or (de)activation with a reason.                                                                                                           |
| `GET /categories` · `PATCH /categories/:id`                    | Category tree with product counts; rename or (de)activate with a reason.                                                                                                                                                      |
| `GET /audit-logs?action=&entity=&actorId=`                     | Newest first, with actor email and request id. `action` filters by prefix.                                                                                                                                                    |

Existing admin routes are kept: `/admin/match-reviews`, `/admin/tracking`,
`/admin/notifications`, and the affiliate imports and payouts.
`admin-platform-routes.ts` was removed; its two read-only routes are
superseded by `/sources` and `/audit-logs` above.

## Agent LLM configuration

- The admin's settings are stored in `AiModelConfig`.
- **Migration `20261124100000_admin_ai_config`** adds:
  - columns for the fallback provider and model, a monthly token limit, input and output paise per 1M tokens, and `updatedById`;
  - CHECKs: provider in `google|openai|rules`, fallback set as a pair, model required unless `rules`, positive limits, max tokens between 256 and 200,000.
- The agent reads `GET /internal/v1/ai-config` (service token).
  - The response includes `limitReached` when this month's `AgentRun` tokens reach the budget.
- `apps/agent/app/providers/configurable.py` (`ConfigurableLlm`) wraps the environment default:
  - **No row:** environment default (`LLM_PROVIDER`, …).
  - **Disabled or budget used:** `RuleBasedLlm` (no LLM calls).
  - **Otherwise:** the named provider and model, with the fallback via `FallbackLlm`.
  - **Refresh:** at most every 60 s, rebuilt only when the configuration changes.
  - **Internal API unreachable:** keeps the last known configuration.
  - **Missing key:** a provider whose key is absent from the agent's environment is rejected and logged; the previous provider stays in use.
- Keys never travel through the API.

## Web pages

- **Pages:** Dashboard, Users (list, detail), Subscriptions, Products (list, detail), Categories, Connectors, AI models, Search analytics, Affiliates, Jobs, System health, Audit log, Settings (read-only rules and links).
- **Patterns:**
  - Every write uses a confirmation dialog with a required reason (`ReasonDialog`); destructive ones use `alertdialog`.
  - Loading and error states are retryable.
  - Tables scroll inside their card, never the page.
  - Health is shown as an icon plus a word, never colour alone.
- **Charts:** Recharts bars with one y-axis, the validated series palette, a 2 px gap between stacked segments, a legend, a tooltip and a "Show as table" view. Ranked lists are thin bars with printed values, inside a real table.

## Tests

| Suite                                               | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API DB `admin-console.db.test.ts` (9)               | 401/403 on every admin endpoint before validation; dashboard values and once-per-hour access audit; search by id; suspend/reactivate with reason, self-refusal, session revocation and audit before/after plus requestId; credential names without values; enable guard (409); settings audit; health-check enqueue; AI config validation, upsert, audit, internal read, budget `limitReached`, cost estimate, health (no forwarded extras), service-token requirement; k-anonymous analytics (rare and private queries and user ids absent); subscription analytics and MRR estimate; failed-job listing without payload, single retry, non-failed 409, dead-letter queue refused; product correction and category update audited. |
| Agent pytest `test_llm_config.py` (5)               | Default kept, disabled or over budget → rules, provider/model/fallback, periodic refresh and API outage, missing key rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Web `admin.test.tsx` (10) and contracts             | Layout: redirect, 404 for non-admins, render for admins; dashboard estimate labels and error retry; reason-required suspend; no self-actions; credential names and enable guard; disable with reason; AI form without key fields; analytics privacy notice; single-job retry. Admin fixtures parse with the shared contracts.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Playwright `admin.spec.ts` (10: desktop and mobile) | Non-admin 404; admin navigation (mobile sheet); no horizontal scroll on 14 pages; axe (no serious or critical violations) in light and dark mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Known gaps

- First-run admin setup via `/setup` and a one-time token (see above); later promotions via an existing admin.
- Collected revenue, taxes and refund amounts are not mirrored. Use the payment service's own reports.
- Notification delivery health stays at `/admin/notifications` (Phase 5.3) and is not yet a console page.
- Match review (`/admin/match-reviews`) is API-only; no console page yet.
