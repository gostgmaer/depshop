"""Phase 21: compose passes optional variables as empty strings; they must mean "unset"."""

from __future__ import annotations

import pytest

from app.config.settings import Settings


def test_empty_optional_variables_are_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in {
        "AGENT_SERVICE_TOKEN": "a" * 40,
        "INTERNAL_API_TOKEN": "b" * 40,
        "AGENT_USER_CONTEXT_SECRET": "c" * 40,
        "CHECKPOINTER": "memory",
        "LLM_PROVIDER": "rules",
        "LLM_FALLBACK_PROVIDER": "",
        "LLM_FALLBACK_MODEL": "",
    }.items():
        monkeypatch.setenv(k, v)
    s = Settings()
    assert s.llm_fallback_provider is None
    assert s.llm_fallback_model == ""


def test_production_still_refuses_the_rule_based_extractor(monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in {
        "NODE_ENV": "production",
        "AGENT_SERVICE_TOKEN": "a" * 40,
        "INTERNAL_API_TOKEN": "b" * 40,
        "AGENT_USER_CONTEXT_SECRET": "c" * 40,
        "CHECKPOINTER": "memory",
        "LLM_PROVIDER": "rules",
    }.items():
        monkeypatch.setenv(k, v)
    with pytest.raises(ValueError, match="real LLM"):
        Settings()
