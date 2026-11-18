"""`python -m app` — runs the agent service with uvicorn.

psycopg's async mode (Postgres checkpointer) can't use Windows' default
ProactorEventLoop, so on Windows a SelectorEventLoop is used explicitly.
On Linux (Docker) the default loop is used.
"""

from __future__ import annotations

import asyncio
import os
import sys

import uvicorn


def main() -> None:
    config = uvicorn.Config(
        "app.main:create_app",
        factory=True,
        host=os.environ.get("AGENT_HOST", "0.0.0.0"),  # noqa: S104 - internal network; see docs
        port=int(os.environ.get("AGENT_PORT", "8100")),
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
        access_log=False,
        # Production behaviour: refuse connections beyond the cap (503) instead of
        # queueing without bound; finish in-flight requests on SIGTERM.
        limit_concurrency=int(os.environ.get("AGENT_MAX_CONNECTIONS", "64")),
        timeout_graceful_shutdown=int(os.environ.get("AGENT_SHUTDOWN_GRACE_SECONDS", "30")),
        timeout_keep_alive=5,
        proxy_headers=False,
        server_header=False,
    )
    server = uvicorn.Server(config)
    if sys.platform == "win32":
        asyncio.run(server.serve(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(server.serve())


if __name__ == "__main__":
    main()
