"""Builds the configured provider (and the fallback, only when configured)."""

from __future__ import annotations

from app.config.settings import LlmProviderName, Settings
from app.providers.base import StructuredLlm
from app.providers.fallback import FallbackLlm
from app.providers.langchain_provider import LangChainStructuredLlm
from app.providers.rules import RuleBasedLlm


class ProviderConfigError(ValueError):
    pass


def _build(name: LlmProviderName, model: str, s: Settings) -> StructuredLlm:
    if name == "rules":
        return RuleBasedLlm()
    if name == "google":
        if s.google_api_key is None:
            raise ProviderConfigError("GOOGLE_API_KEY is not set")
        from langchain_google_genai import ChatGoogleGenerativeAI

        google_chat = ChatGoogleGenerativeAI(
            model=model,
            temperature=s.llm_temperature,
            max_output_tokens=s.llm_max_tokens,
            google_api_key=s.google_api_key.get_secret_value(),
            max_retries=0,  # retries are ours (bounded, with jitter)
        )
        return LangChainStructuredLlm(
            google_chat,
            provider="google",
            model=model,
            timeout_seconds=s.llm_timeout_seconds,
            max_retries=s.llm_max_retries,
        )
    if name == "openai":
        if s.openai_api_key is None:
            raise ProviderConfigError("OPENAI_API_KEY is not set")
        from langchain_openai import ChatOpenAI

        chat = ChatOpenAI(
            model=model,
            temperature=s.llm_temperature,
            max_tokens=s.llm_max_tokens,
            api_key=s.openai_api_key,
            base_url=s.openai_base_url,
            max_retries=0,
            timeout=s.llm_timeout_seconds,
        )
        return LangChainStructuredLlm(
            chat,
            provider="openai",
            model=model,
            timeout_seconds=s.llm_timeout_seconds,
            max_retries=s.llm_max_retries,
        )
    raise ProviderConfigError(f"Unsupported LLM provider: {name}")


def create_llm(settings: Settings) -> StructuredLlm:
    primary = _build(settings.llm_provider, settings.llm_model, settings)
    if settings.llm_fallback_provider:
        return FallbackLlm(
            primary, _build(settings.llm_fallback_provider, settings.llm_fallback_model, settings)
        )
    return primary
