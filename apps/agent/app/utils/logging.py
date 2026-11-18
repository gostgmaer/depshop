"""Structured JSON logging (structlog) with secret redaction."""

from __future__ import annotations

import logging
import os
import re
from collections.abc import MutableMapping
from typing import Any

import structlog

_SENSITIVE = re.compile(r"(token|secret|password|api[_-]?key|authorization|cookie|user_context)", re.I)


def redact(_logger: Any, _method: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    """Drops values of sensitive-looking keys (never log credentials or signed contexts)."""
    for key in list(event):
        if _SENSITIVE.search(key):
            event[key] = "[redacted]"
    return event


def _service_fields(_logger: Any, _method: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    event.setdefault("service", "dealmind-agent")
    event.setdefault("env", os.environ.get("DEPLOY_ENV", os.environ.get("NODE_ENV", "development")))
    return event


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(level=level.upper(), format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            _service_fields,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            redact,
            structlog.processors.dict_tracebacks,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelNamesMapping()[level.upper()]),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "dealmind.agent") -> Any:
    return structlog.get_logger(name)
