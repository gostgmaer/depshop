"""Shared async HTTP client for the Fastify internal API.

Connect/request timeouts, bounded retries with jitter (idempotent calls and
5xx/transport errors only), service bearer auth, correlation ids. Credentials
of marketplaces never pass through here; they stay in the TypeScript services.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx

from app.utils.logging import get_logger

log = get_logger("dealmind.agent.http")
USER_CONTEXT_HEADER = "x-dealmind-user-context"
CORRELATION_HEADER = "x-correlation-id"


class InternalApiError(Exception):
    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class InternalApi:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        connect_timeout: float = 3,
        timeout: float = 45,
        max_retries: int = 2,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"authorization": f"Bearer {token}", "accept": "application/json"},
            timeout=httpx.Timeout(timeout, connect=connect_timeout),
            transport=transport,
        )
        self._max_retries = max_retries

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        correlation_id: str,
        json: Any = None,
        user_context: str | None = None,
        idempotent: bool = True,
        expect_json: bool = True,
    ) -> Any:
        headers = {CORRELATION_HEADER: correlation_id}
        if user_context:
            headers[USER_CONTEXT_HEADER] = user_context
        attempts = self._max_retries + 1 if idempotent else 1
        last: InternalApiError | None = None
        for attempt in range(attempts):
            try:
                res = await self._client.request(method, path, json=json, headers=headers)
            except httpx.TransportError as err:
                last = InternalApiError(f"{method} {path}: {type(err).__name__}", retryable=True)
            else:
                if res.status_code < 400:
                    return res.json() if expect_json and res.content else None
                retryable = res.status_code >= 500 or res.status_code == 429
                detail = _error_message(res)
                last = InternalApiError(
                    f"{method} {path}: HTTP {res.status_code} {detail}",
                    status=res.status_code,
                    retryable=retryable,
                )
                if not retryable:
                    break
            if attempt + 1 < attempts:
                delay = random.uniform(0, 0.25 * 2**attempt)  # noqa: S311 - jitter, not crypto
                log.warning("internal_api_retry", path=path, attempt=attempt + 1, error=str(last))
                await asyncio.sleep(delay)
        assert last is not None
        raise last


def _error_message(res: httpx.Response) -> str:
    try:
        body = res.json()
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            return str(body["error"].get("message", ""))[:200]
    except ValueError:
        pass
    return ""
