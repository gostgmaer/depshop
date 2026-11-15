"""LangGraph checkpointing.

Postgres (default): the official AsyncPostgresSaver in its OWN schema
(`CHECKPOINT_SCHEMA`, default `agent_checkpoints`), so it never mixes with the
Prisma-managed application tables. Thread id = execution id (= AgentRun id), so
a retried job resumes from the last completed node. Memory: tests/local only.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver

from app.config.settings import Settings


def libpq_url(database_url: str) -> str:
    """Prisma-style URL → libpq URL (drops Prisma's `?schema=` and other params)."""
    parts = urlsplit(database_url)
    scheme = "postgresql" if parts.scheme.startswith("postgres") else parts.scheme
    return urlunsplit((scheme, parts.netloc, parts.path, "", ""))


@asynccontextmanager
async def open_checkpointer(settings: Settings) -> AsyncIterator[BaseCheckpointSaver[Any]]:
    if settings.checkpointer == "memory":
        yield InMemorySaver()
        return
    assert settings.database_url
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg import AsyncConnection
    from psycopg.rows import dict_row
    from psycopg.sql import SQL, Identifier
    from psycopg_pool import AsyncConnectionPool

    url = libpq_url(settings.database_url)
    schema = settings.checkpoint_schema
    async with await AsyncConnection.connect(url, autocommit=True) as conn:
        await conn.execute(SQL("CREATE SCHEMA IF NOT EXISTS {}").format(Identifier(schema)))
    pool = AsyncConnectionPool(
        url,
        min_size=1,
        max_size=10,
        open=False,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": f"-c search_path={schema}",
        },
    )
    await pool.open()
    try:
        saver = AsyncPostgresSaver(pool)  # type: ignore[arg-type]
        await saver.setup()
        yield saver
    finally:
        await pool.close()
