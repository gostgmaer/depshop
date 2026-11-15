from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from app.clients.base import InternalApi
from app.clients.intelligence_api import IntelligenceApiClient
from app.clients.marketplace_api import MarketplaceApiClient
from app.config.settings import Settings
from app.nodes.deps import AgentDeps
from app.schemas.api import StartSearchRequest
from app.services.execution_service import ExecutionService
from app.utils.user_context import sign_user_context
from tests.fakes import SECRET, TOKEN, FakeBackend, ScriptedLlm, item


def settings(**over: Any) -> Settings:
    base: dict[str, Any] = {
        "AGENT_SERVICE_TOKEN": TOKEN,
        "INTERNAL_API_TOKEN": TOKEN,
        "AGENT_USER_CONTEXT_SECRET": SECRET,
        "INTERNAL_API_URL": "http://api.test/internal/v1",
        "LLM_PROVIDER": "rules",
        "CHECKPOINTER": "memory",
        "NODE_ENV": "test",
    }
    return Settings(**{**base, **over})


@pytest.fixture
def backend() -> FakeBackend:
    b = FakeBackend()
    b.sources = {
        "mock_alpha": {
            "items": [
                item("mock_alpha", "a1", "Acme Nova 7 5G (8GB RAM, 256GB Storage)", "Acme", 30_999),
                item("mock_alpha", "a2", "Acme Nova 7 5G (8GB RAM, 128GB Storage)", "Acme", 27_999),
                item("mock_alpha", "a3", "Zenith Z9 Smartphone (12GB RAM, 256GB Storage)", "Zenith", 44_999),
            ]
        },
        "mock_beta": {
            "items": [
                item("mock_beta", "b1", "Acme Nova 7 5G (8GB RAM, 256GB Storage)", "Acme", 29_499),
                item("mock_beta", "b2", "Orbit Fold 2 Smartphone (8GB RAM, 256GB Storage)", "Orbit", 34_000),
            ]
        },
    }
    return b


def api_for(backend: FakeBackend, **kw: Any) -> InternalApi:
    return InternalApi("http://api.test/internal/v1", TOKEN, transport=backend.transport(), **kw)


def deps_for(backend: FakeBackend, llm: Any, **kw: Any) -> AgentDeps:
    api = api_for(backend, max_retries=kw.pop("max_retries", 0))
    return AgentDeps(
        llm=llm,
        marketplace=MarketplaceApiClient(api, concurrency=kw.pop("concurrency", 6)),
        intelligence=IntelligenceApiClient(api),
        **kw,
    )


class Ids:
    def __init__(self, backend: FakeBackend) -> None:
        self.user = str(uuid.uuid4())
        self.search = str(uuid.uuid4())
        self.execution = str(uuid.uuid4())
        backend.searches[self.search] = self.user
        backend.runs[self.execution] = self.search

    def context(self, *, exp_in: int = 600, secret: str = SECRET, user: str | None = None) -> str:
        return sign_user_context(
            user or self.user, self.search, self.execution, int(time.time()) + exp_in, secret
        )

    def request(self, query: str, **over: Any) -> StartSearchRequest:
        return StartSearchRequest(
            execution_id=self.execution,
            search_id=self.search,
            user_context=over.pop("user_context", self.context()),
            query=query,
            filters=over.pop("filters", {}),
        )


@pytest.fixture
def ids(backend: FakeBackend) -> Ids:
    return Ids(backend)


@pytest.fixture
def make_service(backend: FakeBackend) -> Callable[..., ExecutionService]:
    def make(llm: Any = None, *, checkpointer: Any = None, **kw: Any) -> ExecutionService:
        deps = deps_for(backend, llm or ScriptedLlm(), **kw.pop("deps", {}))
        return ExecutionService(
            deps,
            deps.intelligence,
            checkpointer if checkpointer is not None else InMemorySaver(),
            user_context_secret=SECRET,
            timeout_seconds=kw.pop("timeout_seconds", 10),
            recursion_limit=kw.pop("recursion_limit", 40),
        )

    return make


async def run_to_end(service: ExecutionService, req: StartSearchRequest) -> Any:
    ex = await service.start(req)
    assert ex.task is not None
    await ex.task
    return ex


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
