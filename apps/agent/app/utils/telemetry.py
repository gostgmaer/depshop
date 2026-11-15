"""OpenTelemetry-compatible instrumentation. Uses the OTel API only, so it is a
no-op until the host installs an SDK/exporter."""

from __future__ import annotations

from opentelemetry import metrics, trace

tracer = trace.get_tracer("dealmind.agent")
_meter = metrics.get_meter("dealmind.agent")
graph_duration = _meter.create_histogram("dealmind.agent.graph.duration", unit="ms")
node_duration = _meter.create_histogram("dealmind.agent.node.duration", unit="ms")
llm_tokens = _meter.create_counter("dealmind.agent.llm.tokens")
