"""Phase 6.3: the agent applies the admin-managed LLM configuration."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import SecretStr

from app.providers.configurable import ConfigurableLlm, build_from_config
from app.providers.fallback import FallbackLlm
from app.providers.rules import RuleBasedLlm
from tests.conftest import settings


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def cfg(**over: Any) -> dict[str, Any]:
    return {
        "provider": "openai",
        "model": "gpt-test-model",
        "temperature": 0.1,
        "maxTokens": 2048,
        "enabled": True,
        "fallbackProvider": None,
        "fallbackModel": None,
        **over,
    }


def keyed() -> Any:
    # Fake keys (never sent anywhere in these tests: no generate() call).
    return settings(google_api_key=SecretStr("g" * 20), openai_api_key=SecretStr("o" * 20))


def test_no_admin_config_keeps_the_environment_default() -> None:
    default = RuleBasedLlm()
    assert build_from_config(None, False, keyed(), default) is default


def test_disabled_or_over_budget_uses_rules_only() -> None:
    default = RuleBasedLlm()
    assert isinstance(build_from_config(cfg(enabled=False), False, keyed(), default), RuleBasedLlm)
    assert isinstance(build_from_config(cfg(), True, keyed(), default), RuleBasedLlm)


def test_configured_provider_model_and_fallback() -> None:
    llm = build_from_config(cfg(), False, keyed(), RuleBasedLlm())
    assert (llm.provider, llm.model) == ("openai", "gpt-test-model")
    fb = build_from_config(
        cfg(fallbackProvider="google", fallbackModel="gemini-test"), False, keyed(), RuleBasedLlm()
    )
    assert isinstance(fb, FallbackLlm)
    assert fb.provider == "openai"


@pytest.mark.asyncio
async def test_refreshes_periodically_and_survives_an_api_outage() -> None:
    calls: list[int] = []
    responses: list[dict[str, Any] | Exception] = [
        {"config": cfg(), "limitReached": False},
        RuntimeError("internal API down"),
        {"config": cfg(enabled=False), "limitReached": False},
    ]

    async def fetch() -> dict[str, Any]:
        calls.append(1)
        r = responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    clock = Clock()
    llm = ConfigurableLlm(RuleBasedLlm(), keyed(), fetch, refresh_seconds=60, clock=clock)
    await llm.refresh()
    assert (llm.provider, llm.model) == ("openai", "gpt-test-model")
    await llm.refresh()  # within the interval: no fetch
    assert len(calls) == 1
    clock.t = 61
    await llm.refresh()  # outage: the last configuration stays
    assert llm.provider == "openai"
    clock.t = 122
    await llm.refresh()  # disabled by the admin
    assert isinstance(llm._current, RuleBasedLlm)
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_a_provider_without_a_key_is_rejected_and_the_previous_one_kept() -> None:
    async def fetch() -> dict[str, Any]:
        return {"config": cfg(provider="google", model="gemini-test"), "limitReached": False}

    default = RuleBasedLlm()
    llm = ConfigurableLlm(default, settings(), fetch, refresh_seconds=60, clock=Clock())
    await llm.refresh()
    assert llm._current is default
