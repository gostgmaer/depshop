"""DealMind AI agent service (FastAPI + LangGraph).

Run: `uv run uvicorn --factory app.main:create_app --host 0.0.0.0 --port 8100` (internal network only).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

from fastapi import FastAPI

from app.api.routes.agent import router as agent_router
from app.checkpointing.checkpointer import open_checkpointer
from app.clients.base import InternalApi
from app.clients.intelligence_api import IntelligenceApiClient
from app.clients.marketplace_api import MarketplaceApiClient
from app.config.settings import Settings, get_settings
from app.database.read_models import ReadModels
from app.nodes.deps import AgentDeps
from app.providers.base import StructuredLlm
from app.providers.configurable import ConfigurableLlm
from app.providers.factory import create_llm
from app.services.execution_service import ExecutionService
from app.utils.logging import configure_logging, get_logger

log = get_logger("dealmind.agent")


def create_app(
    settings: Settings | None = None,
    *,
    llm: StructuredLlm | None = None,
    internal_api: InternalApi | None = None,
    use_read_models: bool = True,
) -> FastAPI:
    """App factory. Tests inject a fake LLM and an internal API with a mock transport."""
    cfg = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configure_logging(cfg.log_level)
        async with AsyncExitStack() as stack:
            api = internal_api or InternalApi(
                cfg.internal_api_url,
                cfg.internal_api_token.get_secret_value(),
                connect_timeout=cfg.internal_api_connect_timeout_seconds,
                timeout=cfg.internal_api_timeout_seconds,
                max_retries=cfg.internal_api_max_retries,
            )
            stack.push_async_callback(api.aclose)
            checkpointer = await stack.enter_async_context(open_checkpointer(cfg))
            read_models = (
                ReadModels.from_url(cfg.database_url) if (use_read_models and cfg.database_url) else None
            )
            if read_models:
                stack.push_async_callback(read_models.dispose)
            intelligence = IntelligenceApiClient(api)
            # Admin-managed LLM settings (read from the internal API, refreshed each minute).
            provider = llm or ConfigurableLlm(
                create_llm(cfg),
                cfg,
                lambda: api.request("GET", "/ai-config", correlation_id="ai-config"),
            )
            deps = AgentDeps(
                llm=provider,
                marketplace=MarketplaceApiClient(api, concurrency=cfg.marketplace_concurrency),
                intelligence=intelligence,
                max_iterations=cfg.max_iterations,
                min_results=cfg.min_results,
                max_results=cfg.max_results,
                narration=cfg.llm_narration,
            )
            service = ExecutionService(
                deps,
                intelligence,
                checkpointer,
                user_context_secret=cfg.user_context_secret.get_secret_value(),
                timeout_seconds=cfg.execution_timeout_seconds,
                recursion_limit=cfg.recursion_limit,
                read_models=read_models,
            )
            stack.push_async_callback(service.shutdown)
            app.state.executions = service
            app.state.provider = provider
            log.info(
                "agent_started",
                provider=provider.provider,
                model=provider.model,
                checkpointer=cfg.checkpointer,
            )
            yield

    app = FastAPI(
        title="DealMind AI agent", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None
    )
    app.state.settings = cfg
    app.include_router(agent_router)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        provider: StructuredLlm | None = getattr(app.state, "provider", None)
        return {
            "status": "ok",
            "provider": provider.provider if provider else None,
            "model": provider.model if provider else None,
        }

    return app
