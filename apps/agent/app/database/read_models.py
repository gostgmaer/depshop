"""Shared-database contract (READ-ONLY).

The Fastify backend owns every application table (Prisma migrations). This
service never creates or writes them: writes go through the authenticated
internal API. Here we only declare the few columns we read to answer status
queries after a restart; the connection is forced read-only.

No Product/ProductVariant/ProductOffer/User/Search models are duplicated.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Column, DateTime, MetaData, String, Table, Text, select
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.checkpointing.checkpointer import libpq_url

metadata = MetaData()

agent_run = Table(
    "AgentRun",
    metadata,
    Column("id", UUID(as_uuid=False), primary_key=True),
    Column("userId", UUID(as_uuid=False)),
    Column("searchId", UUID(as_uuid=False)),
    Column("status", String),
    Column("error", Text),
    Column("finishedAt", DateTime),
)

search = Table(
    "Search",
    metadata,
    Column("id", UUID(as_uuid=False), primary_key=True),
    Column("userId", UUID(as_uuid=False)),
    Column("status", String),
)


@dataclass(frozen=True, slots=True)
class RunRecord:
    execution_id: str
    search_id: str | None
    run_status: str
    search_status: str | None
    error: str | None
    finished: bool


class ReadModels:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    @classmethod
    def from_url(cls, database_url: str) -> ReadModels:
        url = libpq_url(database_url).replace("postgresql://", "postgresql+psycopg://", 1)
        engine = create_async_engine(
            url,
            pool_size=2,
            max_overflow=2,
            connect_args={"options": "-c default_transaction_read_only=on"},
        )
        return cls(engine)

    async def dispose(self) -> None:
        await self._engine.dispose()

    async def agent_run(self, execution_id: str) -> RunRecord | None:
        stmt = (
            select(
                agent_run.c.id,
                agent_run.c.searchId,
                agent_run.c.status,
                agent_run.c.error,
                agent_run.c.finishedAt,
                search.c.status.label("search_status"),
            )
            .select_from(
                agent_run.outerjoin(
                    search, (search.c.id == agent_run.c.searchId) & (search.c.userId == agent_run.c.userId)
                )
            )
            .where(agent_run.c.id == execution_id)
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).first()
        if row is None:
            return None
        return RunRecord(
            execution_id=str(row.id),
            search_id=str(row.searchId) if row.searchId else None,
            run_status=str(row.status),
            search_status=str(row.search_status) if row.search_status else None,
            error=row.error,
            finished=row.finishedAt is not None,
        )
