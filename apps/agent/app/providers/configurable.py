"""Admin-managed LLM configuration (Phase 6.3).

The platform admin sets the provider, model, temperature, token limit,
fallback and a monthly token budget in DealMind's admin console. This wrapper
reads that configuration from the internal API (at most once per refresh
interval) and rebuilds the provider when it changes:

- no admin configuration: the environment defaults (LLM_PROVIDER, ...);
- disabled, or the monthly budget used up: rule-based extraction (no LLM calls);
- otherwise: the configured provider/model, with the configured fallback.

API keys never come from the API: the agent uses its own environment keys
(GOOGLE_API_KEY / OPENAI_API_KEY) for the named provider. If the internal API
is unreachable, the last known configuration stays in use. LLM settings only
affect intent extraction and narration, never pricing or ranking (those are
deterministic services).
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from pydantic import BaseModel

from app.config.settings import Settings
from app.providers.base import LlmResult, StructuredLlm
from app.providers.factory import ProviderConfigError, _build
from app.providers.fallback import FallbackLlm
from app.providers.rules import RuleBasedLlm
from app.utils.logging import get_logger

T = TypeVar("T", bound=BaseModel)
log = get_logger("dealmind.agent.llm_config")

ConfigFetcher = Callable[[], Awaitable[dict[str, Any]]]


def build_from_config(
    config: dict[str, Any] | None, limit_reached: bool, settings: Settings, default: StructuredLlm
) -> StructuredLlm:
    """Pure: the provider for an admin configuration (None = environment default)."""
    if config is None:
        return default
    if not config.get("enabled", True) or limit_reached:
        return RuleBasedLlm()
    s = settings.model_copy(
        update={
            "llm_temperature": float(config.get("temperature", settings.llm_temperature)),
            "llm_max_tokens": int(config.get("maxTokens", settings.llm_max_tokens)),
        }
    )
    primary = _build(config["provider"], config.get("model") or "", s)
    fb_provider = config.get("fallbackProvider")
    if fb_provider:
        return FallbackLlm(primary, _build(fb_provider, config.get("fallbackModel") or "", s))
    return primary


class ConfigurableLlm:
    def __init__(
        self,
        default: StructuredLlm,
        settings: Settings,
        fetch: ConfigFetcher,
        *,
        refresh_seconds: float = 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._default = default
        self._settings = settings
        self._fetch = fetch
        self._refresh_seconds = refresh_seconds
        self._clock = clock
        self._current: StructuredLlm = default
        self._key: str | None = None
        self._next_refresh = 0.0

    @property
    def provider(self) -> str:
        return self._current.provider

    @property
    def model(self) -> str:
        return self._current.model

    async def refresh(self, *, force: bool = False) -> None:
        now = self._clock()
        if not force and now < self._next_refresh:
            return
        self._next_refresh = now + self._refresh_seconds
        try:
            body = await self._fetch()
        except Exception as err:  # keep the last known configuration
            log.warning("llm_config_unavailable", error=str(err)[:200])
            return
        config = body.get("config")
        limit = bool(body.get("limitReached"))
        key = repr((config, limit))
        if key == self._key:
            return
        try:
            self._current = build_from_config(config, limit, self._settings, self._default)
            self._key = key
            log.info(
                "llm_config_applied",
                provider=self._current.provider,
                model=self._current.model,
                limit_reached=limit,
            )
        except ProviderConfigError as err:
            # e.g. the named provider's API key isn't set in this environment.
            log.error("llm_config_rejected", error=str(err))
            self._key = key

    async def generate(self, schema: type[T], system: str, user: str, *, name: str) -> LlmResult[T]:
        await self.refresh()
        return await self._current.generate(schema, system, user, name=name)
