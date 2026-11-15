"""LangChain-backed structured output (Google Gemini, OpenAI, or any chat model
with `with_structured_output`)."""

from __future__ import annotations

import asyncio
import random
from typing import Any, TypeVar

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, ValidationError

from app.providers.base import LlmError, LlmResult, LlmUsage

T = TypeVar("T", bound=BaseModel)


class LangChainStructuredLlm:
    def __init__(
        self,
        chat: BaseChatModel | Any,
        *,
        provider: str,
        model: str,
        timeout_seconds: float = 30,
        max_retries: int = 2,
        base_delay_seconds: float = 0.5,
    ) -> None:
        self._chat = chat
        self._provider = provider
        self._model = model
        self._timeout = timeout_seconds
        self._max_retries = max_retries
        self._base_delay = base_delay_seconds

    @property
    def provider(self) -> str:
        return self._provider

    @property
    def model(self) -> str:
        return self._model

    async def generate(self, schema: type[T], system: str, user: str, *, name: str) -> LlmResult[T]:
        runnable = self._chat.with_structured_output(schema, include_raw=True)
        messages = [SystemMessage(content=system), HumanMessage(content=user)]
        last: Exception | None = None
        usage = LlmUsage()
        for attempt in range(self._max_retries + 1):
            try:
                out = await asyncio.wait_for(
                    runnable.ainvoke(messages, config={"run_name": name, "tags": ["dealmind", name]}),
                    timeout=self._timeout,
                )
                usage = usage.add(_usage(out.get("raw") if isinstance(out, dict) else None))
                parsed = out.get("parsed") if isinstance(out, dict) else out
                if parsed is None:
                    raise LlmError(
                        f"{self._provider} returned no valid structured output: {out.get('parsing_error')}",
                        provider=self._provider,
                    )
                data = parsed if isinstance(parsed, schema) else schema.model_validate(parsed)
                return LlmResult(
                    data=data, usage=usage, provider=self._provider, model=self._model, attempts=attempt + 1
                )
            except (TimeoutError, LlmError, ValidationError, Exception) as err:
                last = err
                if isinstance(err, LlmError) and not err.retryable:
                    break
                if _is_auth_error(err):
                    break
                if attempt < self._max_retries:
                    await asyncio.sleep(random.uniform(0, self._base_delay * 2**attempt))  # noqa: S311 - jitter
        message = "timed out" if isinstance(last, TimeoutError) else str(last)[:300]
        raise LlmError(
            f"{self._provider} ({name}) failed: {message}",
            provider=self._provider,
            retryable=not _is_auth_error(last),
        ) from last


def _usage(raw: Any) -> LlmUsage:
    meta = getattr(raw, "usage_metadata", None) or {}
    try:
        return LlmUsage(int(meta.get("input_tokens", 0)), int(meta.get("output_tokens", 0)))
    except (TypeError, ValueError, AttributeError):
        return LlmUsage()


def _is_auth_error(err: BaseException | None) -> bool:
    text = f"{type(err).__name__} {err}".lower() if err else ""
    return any(s in text for s in ("authentication", "permission", "api key", "unauthorized", "401", "403"))
