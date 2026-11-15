"""Dependencies injected into every node (built once per service, reused)."""

from __future__ import annotations

from dataclasses import dataclass, field

from app.clients.intelligence_api import IntelligenceApiClient
from app.clients.marketplace_api import MarketplaceApiClient
from app.providers.base import StructuredLlm


class ProviderUnavailableError(Exception):
    """The LLM provider failed with a retryable error; the execution fails
    unpersisted so the worker can retry (resuming from the checkpoint)."""


class CancelledByUserError(Exception):
    """The owner cancelled the search; the execution stops at the next node."""


@dataclass(slots=True)
class AgentDeps:
    llm: StructuredLlm
    marketplace: MarketplaceApiClient
    intelligence: IntelligenceApiClient
    max_iterations: int = 2
    min_results: int = 3
    max_results: int = 50
    narration: bool = True
    recently_launched_days: int = 180
    extra: dict[str, object] = field(default_factory=dict)
