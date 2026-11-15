# Shopping intelligence agent (Phase 3.1)

The AI agent is a separate **Python** service (`apps/agent`: Python 3.12, LangGraph, FastAPI, Pydantic, SQLAlchemy). Fastify stays the main backend and the owner of authentication and of every user-facing record.

The agent does three things: it understands intent, it plans the search, and it explains verified results. Matching, pricing, discounts and ranking are deterministic TypeScript services (`@dealmind/catalog`, `@dealmind/intelligence`). Marketplace connectors are the TypeScript `@dealmind/connectors` framework. The agent reaches both through an authenticated internal API and re-implements neither.

## Request flow

```text
browser ─POST /api/v1/search─▶ Fastify ──creates Search(PENDING)──▶ BullMQ "shopping-search"
                                                                         │
                         TypeScript worker (apps/worker) ◀───────────────┘
                           │ creates/reuses AgentRun (execution id = LangGraph thread id)
                           │ signs user context {userId, searchId, executionId, exp} (HMAC)
                           ▼
         POST /internal/agent/search ──▶ Python agent (FastAPI) ── runs LangGraph ──┐
                           │  polls GET …/{execution_id}, cancels on timeout/user   │
                           ▼                                                        ▼
                    marks FAILED only on its final retry          Fastify /internal/v1 (service token)
                                                                    ├─ /sources/eligible, /marketplace/search  → @dealmind/connectors
                                                                    ├─ /intelligence/normalize|deduplicate     → @dealmind/catalog
                                                                    ├─ /intelligence/pricing|rank              → @dealmind/intelligence
                                                                    └─ /searches/:id/(events|agent-result)     → DB (ownership re-checked)
browser ◀─GET /api/v1/search/:id/events (SSE)── Redis pub/sub ◀── progress events
```

We kept BullMQ as the queue rather than adding a second one. The Python service exposes an HTTP API, and the TypeScript worker supervises it: start, poll, timeout, cancel and retry.

## Graph

| #   | Node                  | Kind                                   | What it does                                                                                                                                                                                                                                                                         |
| --- | --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `intent_extractor`    | LLM (structured output, Pydantic)      | Extracts category, type, brands (incl. excluded), model, budget, required/excluded specs, features, launch preference, discount requirement, sort mode, marketplaces (incl. excluded), compare-same-product, keywords and an optional clarification question                         |
| 2   | `query_validator`     | deterministic                          | **Budget grounding:** an LLM budget must literally appear in the query (₹/Rs/k/lakh parser) or it is dropped with a warning, never "adjusted". Explicit API filters win. Specs canonicalized by the catalog normalizer. Contradictions or vague queries → one clarification question |
| 3   | `search_planner`      | deterministic                          | Up to 3 query variants (precise → broad), per-source limit, depth (deep for discount/compare queries), minimum results                                                                                                                                                               |
| 4   | `source_discovery`    | internal API → connector registry      | Eligible sources come from the registry and `ShoppingSource`, never a hardcoded list. Skipped sources carry their reasons. User-excluded marketplaces are dropped                                                                                                                    |
| 5   | `parallel_search`     | internal API → connector executor      | One call per source, bounded `asyncio` concurrency. A failing source becomes a FAILED run; the other sources' results are kept                                                                                                                                                       |
| 6   | `normalize_products`  | internal API → catalog normalizer      | Canonical brand, normalized name, canonical variant attributes                                                                                                                                                                                                                       |
| 7   | `deduplicate`         | internal API → catalog matching engine | Shared offers grouped per product and variant. Variants are never merged; uncertain matches go to manual review                                                                                                                                                                      |
| 8   | `apply_filters`       | deterministic                          | Hard constraints: price incl. shipping, brands, required/excluded specs. A listing that doesn't state a required spec is excluded and counted, never assumed                                                                                                                         |
| 9   | `calculate_discounts` | internal API → pricing engine          | Genuine-discount verdicts from each offer's price history. Discount requirements are applied to those values. "Recently launched" is only enforced when a launch date is known; unknown dates produce a warning                                                                      |
| 10  | `rank_deals`          | internal API → ranking engine          | The agent sends **offer ids only**. The engine reloads prices from the database, so the agent can't inject or alter a price                                                                                                                                                          |
| 11  | `evaluate_results`    | deterministic                          | Too few results with iterations left → search again with the next broader query. Otherwise the outcome is COMPLETED, PARTIAL or FAILED                                                                                                                                               |
| 12  | `generate_response`   | template; optional LLM narration       | The deterministic summary is always produced. LLM narration gets only verified facts and is **rejected** if it contains any ₹/% figure not in the facts, or any URL                                                                                                                  |
| 13  | `save_results`        | internal API                           | Idempotent `PUT /internal/v1/searches/:id/agent-result`                                                                                                                                                                                                                              |

**Conditional edges:**

- A fatal intent error goes straight to respond.
- A clarification is needed: respond, then save, with no search.
- No eligible sources: respond, then save.
- Empty results after the search go straight to evaluation.
- An extra search attempt loops back to `parallel_search`.
- Partial or full success, and execution failures, are classified in `evaluate_results` or the execution service.

**Loop bounds:** `AGENT_MAX_ITERATIONS` (default 2) plus LangGraph's `recursion_limit` (`AGENT_RECURSION_LIMIT`, default 40). Hitting the limit ends the run as FAILED, and that outcome is persisted.

**State** (`app/state/state.py`) is a TypedDict:

- **Identity:** `user_id`, `search_id`, `execution_id`, `user_context`.
- **Query and interpretation:** `original_query`, `intent`, `filters`, `validation`, `plan`.
- **Sources and products:** `selected_sources`, `skipped_sources`, `source_runs`, `products`, `normalized`, `matched_groups`, `ranked_deals`.
- **Run status:** `errors`, `warnings`, `search_status`, `iteration`, `execution_metadata`.

The reducers accumulate across iterations. There is no tenant, organization or membership field.

## Security model

| Hop                     | Authentication                                                                   | Notes                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worker/API → agent      | `Authorization: Bearer AGENT_SERVICE_TOKEN` (constant-time compare)              | Internal network only: no published port, no Traefik labels                                                                                                                                                                                    |
| agent → Fastify         | `Authorization: Bearer INTERNAL_API_TOKEN`                                       | `/internal/v1` is registered only when the token and secret are configured. Traefik routes only `/api`. No cookies, no CSRF                                                                                                                    |
| user identity           | **Signed user context** (HMAC-SHA256, `AGENT_USER_CONTEXT_SECRET`, short expiry) | The worker signs the authenticated owner of the search. The agent verifies it (and that it matches the search and execution). Fastify verifies it again and checks database ownership on every private call. A bare `user_id` is never trusted |
| marketplace credentials | env of the TypeScript API/worker only                                            | Never passed to, or visible to, the agent                                                                                                                                                                                                      |

The persisted results contain offer ids only. `pricePaiseAtSearch` and `mrpPaiseAtSearch` are read from the database by Fastify.

## Persistence and the shared database

- **Fastify owns** `Search`, `SearchResult`, `SearchSourceRun` and `AgentRun`. The agent writes them only through `PUT /internal/v1/searches/:id/agent-result`.
  - That call runs in one transaction, and replaying it replaces the previous results instead of duplicating them.
  - It is refused if another execution already finished the search.
- **SQLAlchemy:** the agent declares a few `AgentRun`/`Search` columns as a **read-only** contract (`default_transaction_read_only=on`). It uses them only to answer status queries after a restart. No Product, Offer, User or Search models are duplicated.
- **LangGraph checkpoints:** the official `AsyncPostgresSaver` runs in its own schema, `agent_checkpoints` (`CHECKPOINT_SCHEMA`), separate from Prisma's tables.
  - The thread id equals the execution id, which equals `AgentRun.id`.
  - A retried job resumes from the last completed node. For example, intent is not re-extracted and sources are not re-searched.

## Execution outcomes

| Situation                                                     | Status                                             | Persisted? | What happens next                                                                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Graph finished                                                | COMPLETED / PARTIAL / FAILED / NEEDS_CLARIFICATION | yes        | Done                                                                                                                                             |
| LLM outage (retryable), internal API down, timeout            | FAILED                                             | **no**     | The worker retries (BullMQ, 3 attempts) with the same execution id, resuming from the checkpoint. The final attempt marks FAILED with the reason |
| LLM auth/config error (not retryable)                         | FAILED                                             | yes        | Honest message; no retry                                                                                                                         |
| User cancels (`POST /api/v1/search/:id/cancel`)               | CANCELLED                                          | yes        | PENDING is cancelled at once. RUNNING: a Redis flag is set and the agent is asked to cancel; it stops at the next node boundary                  |
| Invalid, expired or mismatched user context, or not the owner | refused (403) / FAILED                             | no         | Nothing runs                                                                                                                                     |

## LLM providers

These are configured only through environment variables:

- `LLM_PROVIDER`: `google`, `openai` or `rules`.
- `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_TIMEOUT_SECONDS`, `LLM_MAX_RETRIES`.

Keys come from `GOOGLE_API_KEY` or `OPENAI_API_KEY`, set as env vars or mounted from a secret manager. The code has no model names in it.

- **Structured output:** LangChain `with_structured_output(..., include_raw=True)` returns the validated result plus token usage.
- **Retries:** the provider retries with jitter. Auth errors are never retried.
- **Fallback:** `LLM_FALLBACK_PROVIDER`/`LLM_FALLBACK_MODEL` is used **only when configured**.
- **`rules`:** a deterministic keyword extractor for local development without API keys. It is reported as provider `rules` and refused in production.

## Observability

- **Logs:** structlog JSON, with keys such as `token`, `secret`, `api_key`, `authorization` and `user_context` redacted.
- **OpenTelemetry API:**
  - a span per node;
  - histograms `dealmind.agent.graph.duration` and `dealmind.agent.node.duration`;
  - counter `dealmind.agent.llm.tokens`.
  - These are no-ops until an SDK/exporter is installed (Phase 11).
- **Persisted per run (`AgentRun`):**
  - provider, model, input/output tokens, duration and attempts (retry count);
  - metadata: node timings (`node_ms`), iterations, search timings, fallback use, narration acceptance, filter report and errors.
- **Connector execution metrics:** these stay in the connector framework's Redis metrics, exposed at `/api/v1/sources/:id`.
- **Progress:** each node's start and finish is published to Redis and streamed to the owner via SSE at `GET /api/v1/search/:id/events`.

## Running

```bash
cd apps/agent
uv sync                                  # Python 3.12 (.python-version); deps locked in uv.lock
uv run python -m app                     # serves 127.0.0.1:${AGENT_PORT:-8100} (selector loop on Windows)
pnpm --filter @dealmind/agent test       # pytest; also part of `pnpm check` (ruff, mypy --strict, pytest)
```

Docker: `docker compose --profile app up` builds `apps/agent/Dockerfile` (non-root, uv-locked, no dev deps) and `apps/worker/Dockerfile`. Neither is exposed outside the `dealmind` network.

## Tests

- **Python:** 47 pytest tests with mocked LLM responses and a contract-faithful fake of the internal API. They cover all 18 required categories, plus checkpoint resume, cancellation, timeout and narration grounding. A token signed by the TypeScript `signUserContext` must verify in Python, and Python must produce the identical token.
- **TypeScript:** 13 internal-API integration tests (real PostgreSQL + Redis + mock connectors), 3 search-API tests and 6 worker supervision tests.
- **Cross-language E2E:** run against a disposable database. The built Fastify API, the BullMQ worker and the Python agent (Postgres checkpointer) processed a real queued search. A run looked like this:
  - result COMPLETED;
  - 2 mock stores searched, 5 pending marketplaces skipped with reasons;
  - 4 variant-correct offers within the ₹21,000 budget;
  - 15 checkpoints under the run's thread id.

## Limitations

- **No real LLM was exercised.** No API key is configured here: the Gemini and OpenAI adapters are tested with a stub chat model, and the E2E used the `rules` extractor. The first run with a real model must be checked, especially that structured output works with the chosen model.
- **No real marketplace data.** All real sources are pending credentials or approval (Phase 2.3), so searches return mock-store results only.
- **The ranking engine is a baseline** (relevance, price position, genuine discount, availability). Semantic relevance and personalization are not implemented.
- **Execution state is in memory per agent instance,** with a database fallback for finished runs. Running several agent replicas would need sticky routing by execution id, or a shared execution registry.
- **Cancellation takes effect at node boundaries**, so an in-flight internal API call finishes first.
- **The worker Docker image was not built in this phase.** The agent image was built and smoke-tested.
- **The local dev database still needs the pending reset** (consent outstanding). All verification used disposable `*_test` databases.
