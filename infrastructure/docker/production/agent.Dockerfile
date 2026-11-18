# syntax=docker/dockerfile:1.7
# DealMind AI — production image for the Python agent (FastAPI + LangGraph).
# Build context: repository root.
#   docker build -f infrastructure/docker/production/agent.Dockerfile -t dealmind-agent .
# Internal service only: no published port, reached on the private network.

ARG PYTHON_IMAGE=python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

FROM ${PYTHON_IMAGE} AS deps
COPY --from=ghcr.io/astral-sh/uv:0.11.28 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY apps/agent/pyproject.toml apps/agent/uv.lock ./
# Locked, production-only dependencies.
RUN uv sync --frozen --no-dev --no-install-project

FROM ${PYTHON_IMAGE} AS agent
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home /app agent
WORKDIR /app
COPY --from=deps /app/.venv /app/.venv
COPY apps/agent/app ./app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    AGENT_HOST=0.0.0.0 AGENT_PORT=8100
USER agent
EXPOSE 8100
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/ready', timeout=2).status == 200 else 1)"
ENTRYPOINT ["/usr/bin/tini", "-e", "143", "--"]
CMD ["python", "-m", "app"]
