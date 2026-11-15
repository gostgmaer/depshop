"""LLM provider abstraction: structured output only.

Every call returns a Pydantic-validated object plus token usage. Callers never
parse free text from a model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


@dataclass(slots=True)
class LlmUsage:
    input_tokens: int = 0
    output_tokens: int = 0

    def add(self, other: LlmUsage) -> LlmUsage:
        return LlmUsage(self.input_tokens + other.input_tokens, self.output_tokens + other.output_tokens)


@dataclass(slots=True)
class LlmResult[M: BaseModel]:
    data: M
    usage: LlmUsage = field(default_factory=LlmUsage)
    provider: str = ""
    model: str = ""
    attempts: int = 1
    used_fallback: bool = False


class LlmError(Exception):
    """Provider failure (network, auth, quota, invalid structured output)."""

    def __init__(self, message: str, *, provider: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable


class StructuredLlm(Protocol):
    """A provider that turns (system, user) messages into a validated model."""

    @property
    def provider(self) -> str: ...

    @property
    def model(self) -> str: ...

    async def generate(self, schema: type[T], system: str, user: str, *, name: str) -> LlmResult[T]: ...
