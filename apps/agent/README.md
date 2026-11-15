# DealMind AI agent (Python)

LangGraph shopping-intelligence agent behind an internal FastAPI API. Architecture, security model and limitations: [docs/AGENT.md](../../docs/AGENT.md).

```text
app/
├── main.py                  FastAPI app factory (uvicorn --factory / python -m app)
├── __main__.py              runner (selector event loop on Windows for psycopg)
├── config/settings.py       env configuration (secrets as SecretStr)
├── api/                     /internal/agent routes + service-token dependency
├── graphs/shopping_search.py
├── nodes/                   13 nodes + injected deps
├── state/                   TypedDict state + reducers
├── schemas/                 Pydantic: LLM intent, filters, plan, internal API DTOs, agent API
├── prompts/                 intent + response prompts
├── providers/               StructuredLlm protocol, LangChain (Gemini/OpenAI), fallback, dev rules
├── services/                execution service (start/status/cancel/resume), grounded narrator
├── clients/                 httpx clients for the Fastify internal API (marketplace, intelligence)
├── database/                read-only SQLAlchemy contract (AgentRun/Search status)
├── checkpointing/           AsyncPostgresSaver in its own schema (or in-memory)
└── utils/                   signed user context, rupee parsing, logging, telemetry
```

## Commands

```bash
uv sync                                   # create .venv from uv.lock (Python 3.12)
uv run python -m app                      # run (needs the env below)
uv run pytest -q                          # tests (mocked LLM + fake internal API)
uv run ruff check app tests && uv run ruff format --check app tests
uv run mypy app tests                     # strict
```

These also run through Turbo: `pnpm check` runs the `lint`, `typecheck` and `test` scripts in `package.json`.

## Required environment

| Variable                                                                  | Purpose                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| `AGENT_SERVICE_TOKEN`                                                     | Bearer token callers must present (≥ 32 chars)   |
| `INTERNAL_API_URL`, `INTERNAL_API_TOKEN`                                  | Fastify `/internal/v1` and its token             |
| `AGENT_USER_CONTEXT_SECRET`                                               | HMAC secret shared with the worker and the API   |
| `LLM_PROVIDER`, `LLM_MODEL`, `GOOGLE_API_KEY` / `OPENAI_API_KEY`          | LLM (`rules` = dev-only deterministic extractor) |
| `DATABASE_URL`, `CHECKPOINTER` (`postgres`/`memory`), `CHECKPOINT_SCHEMA` | Checkpoints + read-only status lookups           |

Optional settings are `LLM_FALLBACK_*`, `AGENT_MAX_ITERATIONS`, `AGENT_MIN_RESULTS`, `AGENT_EXECUTION_TIMEOUT_SECONDS`, `MARKETPLACE_CONCURRENCY`, `INTERNAL_API_*_TIMEOUT_SECONDS` and `LOG_LEVEL`. See `app/config/settings.py`.

Dependencies are resolved with `exclude-newer = 2026-11-01`, so only releases at least two weeks old are used (supply-chain hygiene).
