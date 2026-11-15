"""Explicitly configured provider fallback (LLM_FALLBACK_PROVIDER). Never implicit."""

from __future__ import annotations

from typing import TypeVar

from pydantic import BaseModel

from app.providers.base import LlmError, LlmResult, StructuredLlm
from app.utils.logging import get_logger

T = TypeVar("T", bound=BaseModel)
log = get_logger("dealmind.agent.llm")


class FallbackLlm:
    def __init__(self, primary: StructuredLlm, fallback: StructuredLlm) -> None:
        self._primary = primary
        self._fallback = fallback

    @property
    def provider(self) -> str:
        return self._primary.provider

    @property
    def model(self) -> str:
        return self._primary.model

    async def generate(self, schema: type[T], system: str, user: str, *, name: str) -> LlmResult[T]:
        try:
            return await self._primary.generate(schema, system, user, name=name)
        except LlmError as err:
            log.warning(
                "llm_fallback",
                call=name,
                primary=self._primary.provider,
                fallback=self._fallback.provider,
                error=str(err)[:200],
            )
            result = await self._fallback.generate(schema, system, user, name=name)
            result.used_fallback = True
            return result
