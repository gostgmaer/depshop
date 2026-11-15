"""Request/response models of this service's internal API (/internal/agent)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ExecutionStatus = Literal[
    "QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "NEEDS_CLARIFICATION", "CANCELLED"
]
TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"COMPLETED", "PARTIAL", "FAILED", "NEEDS_CLARIFICATION", "CANCELLED"}
)


class StartSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    execution_id: str = Field(pattern=r"^[0-9a-f-]{36}$", description="AgentRun id = LangGraph thread id")
    search_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    user_context: str = Field(min_length=20, max_length=2_000, description="Signed by the TypeScript worker")
    query: str = Field(min_length=2, max_length=500)
    filters: dict[str, Any] = Field(
        default_factory=dict, description="Explicit user filters (they win over the AI)"
    )


class ExecutionStatusResponse(BaseModel):
    execution_id: str
    search_id: str | None = None
    status: ExecutionStatus
    persisted: bool = Field(description="Results were saved through the Fastify internal API")
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    iterations: int = 0
    result_count: int = 0
