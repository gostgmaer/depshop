"""Runs graph executions: idempotent start, status, cancellation, timeout,
checkpoint resume and outcome classification.

Outcomes
  - finished graph (results persisted by save_results) → its status;
  - user cancellation → CANCELLED, persisted through the internal API;
  - retryable failure (LLM outage, internal API down, timeout) → FAILED,
    NOT persisted: the TypeScript worker retries the job with the same
    execution id and the graph resumes from its last checkpoint;
  - invalid user context / not the owner → refused, nothing runs.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.errors import GraphRecursionError

from app.clients.base import InternalApiError
from app.clients.intelligence_api import IntelligenceApiClient
from app.database.read_models import ReadModels
from app.graphs.shopping_search import build_graph
from app.nodes.deps import AgentDeps, CancelledByUserError, ProviderUnavailableError
from app.nodes.save_results import aggregate_source_runs
from app.schemas.api import TERMINAL_STATUSES, ExecutionStatusResponse, StartSearchRequest
from app.utils.logging import get_logger
from app.utils.telemetry import graph_duration
from app.utils.user_context import UserContext, verify_user_context

log = get_logger("dealmind.agent.execution")


class UserContextError(Exception):
    """The signed user context is missing, invalid, expired or doesn't match."""


@dataclass(slots=True)
class Execution:
    execution_id: str
    search_id: str
    user: UserContext
    status: str = "QUEUED"
    persisted: bool = False
    error: str | None = None
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    finished_at: str | None = None
    iterations: int = 0
    result_count: int = 0
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None

    def view(self) -> ExecutionStatusResponse:
        return ExecutionStatusResponse(
            execution_id=self.execution_id,
            search_id=self.search_id,
            status=self.status,
            persisted=self.persisted,
            error=self.error,
            started_at=self.started_at,
            finished_at=self.finished_at,
            iterations=self.iterations,
            result_count=self.result_count,
        )


class ExecutionService:
    def __init__(
        self,
        deps: AgentDeps,
        intelligence: IntelligenceApiClient,
        checkpointer: BaseCheckpointSaver[Any] | None,
        *,
        user_context_secret: str,
        timeout_seconds: float,
        recursion_limit: int,
        read_models: ReadModels | None = None,
        max_tracked: int = 2_000,
    ) -> None:
        self._deps = deps
        self._intelligence = intelligence
        self._checkpointer = checkpointer
        self._secret = user_context_secret
        self._timeout = timeout_seconds
        self._recursion_limit = recursion_limit
        self._read_models = read_models
        self._max_tracked = max_tracked
        self._executions: dict[str, Execution] = {}

    # ── public API ────────────────────────────────────────────────────────

    def verify(self, req: StartSearchRequest) -> UserContext:
        ctx = verify_user_context(req.user_context, self._secret)
        if ctx is None:
            raise UserContextError("Invalid or expired user context")
        if ctx.search_id != req.search_id or ctx.execution_id != req.execution_id:
            raise UserContextError("User context does not match this search/execution")
        return ctx

    async def start(self, req: StartSearchRequest) -> Execution:
        ctx = self.verify(req)
        existing = self._executions.get(req.execution_id)
        if existing and (existing.status not in TERMINAL_STATUSES or existing.persisted):
            return existing  # idempotent: running, or finished and saved
        ex = Execution(req.execution_id, req.search_id, ctx)
        self._executions[req.execution_id] = ex
        self._evict()
        ex.task = asyncio.create_task(self._run(ex, req), name=f"agent-{req.execution_id}")
        return ex

    def get(self, execution_id: str) -> Execution | None:
        return self._executions.get(execution_id)

    async def status(self, execution_id: str) -> ExecutionStatusResponse | None:
        ex = self._executions.get(execution_id)
        if ex:
            return ex.view()
        if self._read_models is None:
            return None
        record = await self._read_models.agent_run(execution_id)
        if record is None or not record.finished:
            return None  # unknown here (e.g. restarted): the worker retries → resume from checkpoint
        status = record.search_status if record.search_status in TERMINAL_STATUSES else "FAILED"
        return ExecutionStatusResponse(
            execution_id=execution_id,
            search_id=record.search_id,
            status=status,
            persisted=True,
            error=record.error,
        )

    def cancel(self, execution_id: str) -> bool:
        ex = self._executions.get(execution_id)
        if ex is None or ex.status in TERMINAL_STATUSES:
            return False
        ex.cancel.set()
        return True

    async def shutdown(self) -> None:
        tasks = [e.task for e in self._executions.values() if e.task and not e.task.done()]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # ── internals ─────────────────────────────────────────────────────────

    def _evict(self) -> None:
        if len(self._executions) <= self._max_tracked:
            return
        for key in [k for k, e in self._executions.items() if e.status in TERMINAL_STATUSES][
            : len(self._executions) - self._max_tracked
        ]:
            self._executions.pop(key, None)

    async def _emit(self, ex: Execution, event: dict[str, Any]) -> None:
        try:
            await self._intelligence.post_event(
                ex.search_id,
                {**event, "at": datetime.now(UTC).isoformat()},
                user_context=ex.user.token,
                correlation_id=ex.execution_id,
            )
        except InternalApiError as err:  # progress is best effort
            log.debug("progress_event_failed", error=str(err)[:200])

    def _initial_state(self, ex: Execution, req: StartSearchRequest) -> dict[str, Any]:
        return {
            "user_id": ex.user.user_id,
            "search_id": ex.search_id,
            "execution_id": ex.execution_id,
            "user_context": ex.user.token,
            "original_query": req.query,
            "explicit_filters": req.filters,
            "iteration": 0,
            "search_status": "PENDING",
            "errors": [],
            "warnings": [],
            "products": [],
            "source_runs": [],
            "execution_metadata": {"started_at_epoch": time.time()},
        }

    async def _run(self, ex: Execution, req: StartSearchRequest) -> None:
        started = time.perf_counter()
        ex.status = "RUNNING"
        config: RunnableConfig = {
            "configurable": {"thread_id": ex.execution_id},
            "recursion_limit": self._recursion_limit,
        }
        graph = build_graph(
            self._deps,
            checkpointer=self._checkpointer,
            is_cancelled=ex.cancel.is_set,
            emit=lambda e: self._emit(ex, e),
        )
        try:
            # Ownership re-check against the authoritative backend.
            await self._intelligence.get_search(
                ex.search_id, user_context=ex.user.token, correlation_id=ex.execution_id
            )
            graph_input: dict[str, Any] | None = self._initial_state(ex, req)
            if self._checkpointer is not None:
                snapshot = await graph.aget_state(config)
                if snapshot.values and snapshot.next:
                    graph_input = None  # resume after a crash/retry
                    log.info(
                        "resuming_from_checkpoint", execution_id=ex.execution_id, next=list(snapshot.next)
                    )
                elif snapshot.values and snapshot.values.get("persisted"):
                    self._finish(ex, snapshot.values, started)
                    return
            final = await asyncio.wait_for(graph.ainvoke(graph_input, config), timeout=self._timeout)
            self._finish(ex, final, started)
        except CancelledByUserError:
            await self._persist_terminal(ex, config, graph, "CANCELLED", "Cancelled by user")
        except GraphRecursionError:
            await self._persist_terminal(ex, config, graph, "FAILED", "Execution exceeded its step limit")
        except ProviderUnavailableError as err:
            self._fail(ex, str(err))
        except TimeoutError:
            self._fail(ex, f"Execution timed out after {self._timeout:g}s")
        except InternalApiError as err:
            if err.status in (403, 404):
                ex.status, ex.error = "FAILED", "Search not found for this user"
                ex.finished_at = datetime.now(UTC).isoformat()
            else:
                self._fail(ex, f"Internal API unavailable: {err}")
        except asyncio.CancelledError:
            self._fail(ex, "Agent service shutting down")
            raise
        except Exception as err:
            log.exception("execution_failed", execution_id=ex.execution_id)
            self._fail(ex, f"Unexpected error: {type(err).__name__}")
        finally:
            graph_duration.record(int((time.perf_counter() - started) * 1000), {"status": ex.status})
            log.info(
                "execution_finished", execution_id=ex.execution_id, status=ex.status, persisted=ex.persisted
            )

    def _finish(self, ex: Execution, final: dict[str, Any], started: float) -> None:
        ex.status = str(final.get("search_status", "FAILED"))
        ex.persisted = bool(final.get("persisted"))
        ex.iterations = int(final.get("iteration", 0))
        ex.result_count = len(final.get("ranked_deals", []) or [])
        ex.finished_at = datetime.now(UTC).isoformat()

    def _fail(self, ex: Execution, message: str) -> None:
        ex.status, ex.persisted, ex.error = "FAILED", False, message[:1_000]
        ex.finished_at = datetime.now(UTC).isoformat()

    async def _persist_terminal(
        self, ex: Execution, config: RunnableConfig, graph: Any, status: str, message: str
    ) -> None:
        """Persists a CANCELLED/FAILED outcome (no results) through the internal API."""
        values: dict[str, Any] = {}
        try:
            snapshot = await graph.aget_state(config)
            values = dict(snapshot.values or {})
        except Exception:
            values = {}
        payload = {
            "status": status,
            "interpretation": None,
            "clarificationQuestion": None,
            "response": message,
            "warnings": [],
            "rankedDeals": [],
            "sourceRuns": aggregate_source_runs(values) if values else [],  # type: ignore[arg-type]
            "agentRun": {
                "provider": str((values.get("execution_metadata") or {}).get("llm", {}).get("provider", "")),
                "model": str((values.get("execution_metadata") or {}).get("llm", {}).get("model", "")),
                "inputTokens": 0,
                "outputTokens": 0,
                "durationMs": 0,
                "metadata": {"reason": message},
                "error": message if status == "FAILED" else None,
            },
        }
        try:
            await self._intelligence.save_result(
                ex.search_id, payload, user_context=ex.user.token, correlation_id=ex.execution_id
            )
            ex.status, ex.persisted, ex.error = status, True, message
            ex.finished_at = datetime.now(UTC).isoformat()
        except InternalApiError as err:
            self._fail(ex, f"{message}; could not persist: {err}")
