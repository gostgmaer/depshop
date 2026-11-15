"""Node 1: understand the query (LLM, structured output, Pydantic-validated)."""

from __future__ import annotations

from typing import Any

from app.nodes.deps import AgentDeps, ProviderUnavailableError
from app.prompts.intent import INTENT_SYSTEM, intent_user_prompt
from app.providers.base import LlmError
from app.schemas.intent import ExtractedIntent
from app.state.state import ShoppingSearchState
from app.utils.telemetry import llm_tokens


async def intent_extractor(state: ShoppingSearchState, deps: AgentDeps) -> dict[str, Any]:
    try:
        result = await deps.llm.generate(
            ExtractedIntent,
            INTENT_SYSTEM,
            intent_user_prompt(state["original_query"]),
            name="intent_extractor",
        )
    except LlmError as err:
        if err.retryable:
            raise ProviderUnavailableError(f"AI provider unavailable: {err}") from err
        # Configuration/auth problems won't fix themselves: fail honestly now.
        return {
            "next_action": "fail",
            "search_status": "FAILED",
            "errors": [{"stage": "intent_extractor", "code": "AI_PROVIDER_ERROR", "message": str(err)[:500]}],
        }
    llm_tokens.add(result.usage.input_tokens + result.usage.output_tokens, {"provider": result.provider})
    return {
        "intent": result.data.model_dump(),
        "next_action": "validate",
        "execution_metadata": {
            "llm": {
                "provider": result.provider,
                "model": result.model,
                "used_fallback": result.used_fallback,
                "intent_attempts": result.attempts,
            },
            "tokens": {"intent_extractor": [result.usage.input_tokens, result.usage.output_tokens]},
        },
    }
