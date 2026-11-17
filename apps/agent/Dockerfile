# DealMind AI agent (Python 3.12 + LangGraph + FastAPI). Internal service only.
# Build context: repository root.  docker build -f apps/agent/Dockerfile .
FROM python:3.12-slim-bookworm AS base
COPY --from=ghcr.io/astral-sh/uv:0.11.28 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1
WORKDIR /app

FROM base AS deps
COPY apps/agent/pyproject.toml apps/agent/uv.lock ./
# Locked, production-only dependencies (no dev tools in the image).
RUN uv sync --frozen --no-dev --no-install-project

FROM base AS runtime
# Phase 7.1: apply Debian security updates; uv is a build tool, not needed at runtime.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* /usr/local/bin/uv
RUN useradd --system --uid 10001 --home /app agent
COPY --from=deps /app/.venv /app/.venv
COPY apps/agent/app ./app
ENV PATH="/app/.venv/bin:$PATH" \
    AGENT_HOST=0.0.0.0 \
    AGENT_PORT=8100
USER agent
EXPOSE 8100
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=2).status == 200 else 1)"
CMD ["python", "-m", "app"]
