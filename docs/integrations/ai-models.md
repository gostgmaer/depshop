# AI model (LLM)

**What it does:** the search agent (`agent` container, Python) uses a language model for two
things only: understanding what the shopper typed (intent extraction) and writing the short
result summary. **Prices, deal ranking and product matching never use AI**; they are
deterministic, so changing the model never changes which deal wins.

**Providers supported:** `google`, `openai`, and `rules` (a built-in keyword extractor,
model `keyword-rules-v1`: no external calls, no cost, development only).

## What are we using right now?

Three ways to see it, from easiest:

1. **Admin → AI models** (`/admin/ai-models`): the active provider and model, plus usage this
   month per provider/model (runs, tokens, failures, estimated cost once prices are entered).
   **Check agent** runs a live health check.
2. **Agent log:** every start logs the provider and model; admin changes log `llm_config_applied`.
   ```
   docker logs dealmind-local-agent-1 2>&1 | grep -E "agent_started|llm_config_applied"
   ```
3. **Agent health endpoint** (inside the Docker network): `GET http://agent:8100/health` returns
   `{"provider": "...", "model": "..."}`.

## Which setting wins

1. A provider/model **saved in Admin → AI models**. The agent rereads it periodically, so no
   restart is needed.
2. Otherwise the environment: `LLM_PROVIDER`, `LLM_MODEL` (and `LLM_FALLBACK_*`).
3. If AI is **disabled** in the admin page, or the **monthly token limit** is used up, it
   falls back to `rules` automatically.

If the API is unreachable, the agent keeps its last known configuration.

## Credentials

| Provider                   | Variable                               | Where from                                                                          |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| Google (Gemini)            | `GOOGLE_API_KEY`                       | Google AI Studio or Google Cloud console (API key with the Generative Language API) |
| OpenAI                     | `OPENAI_API_KEY`                       | OpenAI platform dashboard → API keys                                                |
| OpenAI-compatible endpoint | `OPENAI_BASE_URL` (+ `OPENAI_API_KEY`) | Only if you use a compatible gateway                                                |

**API keys only ever live in the agent's environment.** The admin page chooses the provider
and model name; it never stores or shows a key. Set a spending cap at the provider too.

`LLM_MODEL` is the provider's own model name, exactly as the provider lists it. Pick it from
the provider's current model list; the agent refuses to start with a real provider and no model.

## Turn it on

1. Add the key to `.env` (local) or `.env.production`:
   ```
   GOOGLE_API_KEY=...        # or OPENAI_API_KEY=...
   ```
2. Production: also set `LLM_PROVIDER` and `LLM_MODEL` (`check-env.sh` requires them and the key).
3. Recreate the agent:
   ```
   # local
   docker compose -f infrastructure/docker/local/docker-compose.yml --project-directory . -p dealmind-local up -d --force-recreate agent
   # production
   scripts/deploy/compose.sh up -d --force-recreate agent
   ```
   Local note: the local compose currently passes only `LLM_PROVIDER` to the agent. Add
   `LLM_MODEL`, `GOOGLE_API_KEY` / `OPENAI_API_KEY` to its `agent` service before using a real model locally.
4. In **Admin → AI models**: choose the provider, type the model name, optionally a fallback
   provider/model and a monthly token limit, and the per-million-token prices for cost estimates.
5. **Verify:** click **Check agent**, run one search, and confirm the usage table shows the new
   provider/model with token counts above zero.

## Turn it off / emergencies

- Disable AI in Admin → AI models: searches continue with `rules`, no restart.
- Key leaked: revoke it at the provider first, then replace the variable and recreate the agent.
- Production refuses `rules` as the primary or fallback provider (the agent won't start).

More: [`../AGENT.md`](../AGENT.md), [`../ai-cost-optimization.md`](../ai-cost-optimization.md).
