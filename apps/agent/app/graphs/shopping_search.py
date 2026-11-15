"""The shopping-search LangGraph.

    START → intent_extractor ─┬─(ok)→ query_validator ─┬─(valid)→ search_planner → source_discovery ─┐
                              └─(fatal)─────────┐       └─(clarify)──────┐                              │
                                                ▼                         ▼                ┌──(none)───┘
                                         generate_response ◀──────────────────────────────┤
                                                ▲                                        (sources)
                                                │                                           ▼
       evaluate_results ─(done)─────────────────┘        ┌──────────────────────────── parallel_search
        ▲   └─(search_more, bounded)─────────────────────┘                 │(items)        │(no items)
        │                                                                   ▼               │
        └── rank_deals ← calculate_discounts ← apply_filters ← deduplicate ← normalize      │
        ▲                                                                                   │
        └───────────────────────────────────────────────────────────────────────────────────┘
    generate_response → save_results → END

AI (LLM) is used only in intent_extractor and (optionally, validated) in
generate_response. Matching, pricing, discounts and ranking are deterministic
TypeScript services called through the internal API.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from app.nodes.apply_filters import apply_filters
from app.nodes.calculate_discounts import calculate_discounts
from app.nodes.deduplicate import deduplicate
from app.nodes.deps import AgentDeps, CancelledByUserError
from app.nodes.evaluate_results import evaluate_results
from app.nodes.generate_response import generate_response
from app.nodes.intent_extractor import intent_extractor
from app.nodes.normalize_products import normalize_products
from app.nodes.parallel_search import parallel_search
from app.nodes.query_validator import query_validator
from app.nodes.rank_deals import rank_deals
from app.nodes.save_results import save_results
from app.nodes.search_planner import search_planner
from app.nodes.source_discovery import source_discovery
from app.state.state import ShoppingSearchState
from app.utils.logging import get_logger
from app.utils.telemetry import node_duration, tracer

log = get_logger("dealmind.agent.graph")

NodeFn = Callable[[ShoppingSearchState, AgentDeps], Awaitable[dict[str, Any]]]
Emit = Callable[[dict[str, Any]], Awaitable[None]]

NODES: dict[str, NodeFn] = {
    "intent_extractor": intent_extractor,
    "query_validator": query_validator,
    "search_planner": search_planner,
    "source_discovery": source_discovery,
    "parallel_search": parallel_search,
    "normalize_products": normalize_products,
    "deduplicate": deduplicate,
    "apply_filters": apply_filters,
    "calculate_discounts": calculate_discounts,
    "rank_deals": rank_deals,
    "evaluate_results": evaluate_results,
    "generate_response": generate_response,
    "save_results": save_results,
}


async def _noop_emit(_event: dict[str, Any]) -> None:
    return None


def _wrap(
    name: str, fn: NodeFn, deps: AgentDeps, is_cancelled: Callable[[], bool], emit: Emit
) -> Callable[[ShoppingSearchState], Awaitable[dict[str, Any]]]:
    async def node(state: ShoppingSearchState) -> dict[str, Any]:
        # Cancellation is honoured between nodes (save_results still runs for
        # a cancellation so the outcome is persisted by the service).
        if is_cancelled():
            raise CancelledByUserError(f"cancelled before {name}")
        await emit({"type": "node_started", "node": name})
        started = time.perf_counter()
        with tracer.start_as_current_span(f"agent.node {name}") as span:
            span.set_attribute("dealmind.execution_id", state["execution_id"])
            update = await fn(state, deps)
        ms = int((time.perf_counter() - started) * 1000)
        node_duration.record(ms, {"node": name})
        previous = ((state.get("execution_metadata") or {}).get("node_ms") or {}).get(name, 0)
        meta = update.get("execution_metadata") or {}
        update["execution_metadata"] = {**meta, "node_ms": {name: int(previous) + ms}}
        log.info("node_finished", node=name, ms=ms, execution_id=state["execution_id"])
        await emit({"type": "node_finished", "node": name})
        return update

    node.__name__ = name
    return node


def _after_intent(state: ShoppingSearchState) -> str:
    return "generate_response" if state.get("next_action") == "fail" else "query_validator"


def _after_validation(state: ShoppingSearchState) -> str:
    return "search_planner" if state.get("next_action") == "plan" else "generate_response"


def _after_discovery(state: ShoppingSearchState) -> str:
    return "parallel_search" if state.get("next_action") == "search" else "generate_response"


def _after_search(state: ShoppingSearchState) -> str:
    # Empty results (or every source failed): evaluate directly.
    return "normalize_products" if state.get("products") else "evaluate_results"


def _after_evaluation(state: ShoppingSearchState) -> str:
    return "parallel_search" if state.get("next_action") == "search_more" else "generate_response"


def build_graph(
    deps: AgentDeps,
    *,
    checkpointer: BaseCheckpointSaver[Any] | None = None,
    is_cancelled: Callable[[], bool] = lambda: False,
    emit: Emit = _noop_emit,
) -> CompiledStateGraph[Any, Any, Any, Any]:
    graph: StateGraph[Any] = StateGraph(ShoppingSearchState)
    for name, fn in NODES.items():
        graph.add_node(name, _wrap(name, fn, deps, is_cancelled, emit))  # type: ignore[call-overload]
    graph.add_edge(START, "intent_extractor")
    graph.add_conditional_edges("intent_extractor", _after_intent, ["query_validator", "generate_response"])
    graph.add_conditional_edges("query_validator", _after_validation, ["search_planner", "generate_response"])
    graph.add_edge("search_planner", "source_discovery")
    graph.add_conditional_edges(
        "source_discovery", _after_discovery, ["parallel_search", "generate_response"]
    )
    graph.add_conditional_edges("parallel_search", _after_search, ["normalize_products", "evaluate_results"])
    graph.add_edge("normalize_products", "deduplicate")
    graph.add_edge("deduplicate", "apply_filters")
    graph.add_edge("apply_filters", "calculate_discounts")
    graph.add_edge("calculate_discounts", "rank_deals")
    graph.add_edge("rank_deals", "evaluate_results")
    graph.add_conditional_edges(
        "evaluate_results", _after_evaluation, ["parallel_search", "generate_response"]
    )
    graph.add_edge("generate_response", "save_results")
    graph.add_edge("save_results", END)
    return graph.compile(checkpointer=checkpointer)
