"""Service-to-service authentication: `Authorization: Bearer <AGENT_SERVICE_TOKEN>`.
Constant-time comparison of SHA-256 digests (length isn't leaked either)."""

from __future__ import annotations

import hashlib
import hmac

from fastapi import Header, HTTPException, Request, status


def token_matches(header: str | None, expected: str) -> bool:
    if not header or not header.startswith("Bearer "):
        return False
    given = header.removeprefix("Bearer ").strip()
    return hmac.compare_digest(
        hashlib.sha256(given.encode()).digest(), hashlib.sha256(expected.encode()).digest()
    )


async def require_service_token(request: Request, authorization: str | None = Header(default=None)) -> None:
    expected: str = request.app.state.settings.agent_service_token.get_secret_value()
    if not token_matches(authorization, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Service authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
