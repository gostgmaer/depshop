"""Agent configuration. Secrets only from the environment (or a secret manager
that mounts them as env vars); never hardcoded, never logged."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

LlmProviderName = Literal["google", "openai", "rules"]


class Settings(BaseSettings):
    # env_ignore_empty: an empty variable (e.g. LLM_FALLBACK_PROVIDER= from compose) means "unset".
    model_config = SettingsConfigDict(
        env_file=None, extra="ignore", populate_by_name=True, env_ignore_empty=True
    )

    environment: Literal["development", "test", "production"] = Field(
        "development", validation_alias=AliasChoices("NODE_ENV", "ENVIRONMENT")
    )

    # ── Service-to-service auth ──────────────────────────────────────────
    agent_service_token: SecretStr = Field(min_length=32, validation_alias="AGENT_SERVICE_TOKEN")
    """Bearer token the TypeScript worker/API must present to this service."""
    internal_api_url: str = Field("http://127.0.0.1:4000/internal/v1", validation_alias="INTERNAL_API_URL")
    internal_api_token: SecretStr = Field(min_length=32, validation_alias="INTERNAL_API_TOKEN")
    """Bearer token this service presents to the Fastify internal API."""
    user_context_secret: SecretStr = Field(min_length=32, validation_alias="AGENT_USER_CONTEXT_SECRET")

    # ── LLM provider (structured output). Model names live only here. ─────
    llm_provider: LlmProviderName = Field("google", validation_alias="LLM_PROVIDER")
    llm_model: str = Field("", validation_alias="LLM_MODEL")
    llm_temperature: float = Field(0.2, ge=0, le=2, validation_alias="LLM_TEMPERATURE")
    llm_max_tokens: int = Field(8192, ge=256, le=200_000, validation_alias="LLM_MAX_TOKENS")
    llm_timeout_seconds: float = Field(30, gt=0, le=300, validation_alias="LLM_TIMEOUT_SECONDS")
    llm_max_retries: int = Field(2, ge=0, le=5, validation_alias="LLM_MAX_RETRIES")
    llm_fallback_provider: LlmProviderName | None = Field(None, validation_alias="LLM_FALLBACK_PROVIDER")
    llm_fallback_model: str = Field("", validation_alias="LLM_FALLBACK_MODEL")
    llm_narration: bool = Field(True, validation_alias="LLM_NARRATION")
    google_api_key: SecretStr | None = Field(None, validation_alias="GOOGLE_API_KEY")
    openai_api_key: SecretStr | None = Field(None, validation_alias="OPENAI_API_KEY")
    openai_base_url: str | None = Field(None, validation_alias="OPENAI_BASE_URL")

    # ── Graph execution ──────────────────────────────────────────────────
    max_iterations: int = Field(2, ge=1, le=5, validation_alias="AGENT_MAX_ITERATIONS")
    min_results: int = Field(3, ge=1, le=50, validation_alias="AGENT_MIN_RESULTS")
    max_results: int = Field(50, ge=1, le=100, validation_alias="AGENT_MAX_RESULTS")
    execution_timeout_seconds: float = Field(
        150, gt=0, le=900, validation_alias="AGENT_EXECUTION_TIMEOUT_SECONDS"
    )
    recursion_limit: int = Field(40, ge=15, le=200, validation_alias="AGENT_RECURSION_LIMIT")

    # ── Internal API client ──────────────────────────────────────────────
    internal_api_connect_timeout_seconds: float = Field(
        3, gt=0, validation_alias="INTERNAL_API_CONNECT_TIMEOUT_SECONDS"
    )
    internal_api_timeout_seconds: float = Field(45, gt=0, validation_alias="INTERNAL_API_TIMEOUT_SECONDS")
    internal_api_max_retries: int = Field(2, ge=0, le=5, validation_alias="INTERNAL_API_MAX_RETRIES")
    marketplace_concurrency: int = Field(6, ge=1, le=20, validation_alias="MARKETPLACE_CONCURRENCY")

    # ── Checkpointing + read-only status lookups (shared PostgreSQL) ──────
    database_url: str | None = Field(None, validation_alias="DATABASE_URL")
    checkpointer: Literal["postgres", "memory"] = Field("postgres", validation_alias="CHECKPOINTER")
    checkpoint_schema: str = Field(
        "agent_checkpoints", pattern=r"^[a-z_][a-z0-9_]{0,62}$", validation_alias="CHECKPOINT_SCHEMA"
    )

    log_level: str = Field("INFO", validation_alias="LOG_LEVEL")

    @model_validator(mode="after")
    def _check(self) -> Settings:
        if self.checkpointer == "postgres" and not self.database_url:
            raise ValueError("DATABASE_URL is required when CHECKPOINTER=postgres")
        for provider, model in (
            (self.llm_provider, self.llm_model),
            (self.llm_fallback_provider, self.llm_fallback_model),
        ):
            if provider not in (None, "rules") and not model:
                raise ValueError(f"A model must be configured for LLM provider '{provider}'")
        if self.environment == "production" and "rules" in (self.llm_provider, self.llm_fallback_provider):
            raise ValueError(
                "The rule-based extractor is a development aid; configure a real LLM in production"
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # values come from the environment
