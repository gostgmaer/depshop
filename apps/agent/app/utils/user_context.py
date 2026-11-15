"""Signed user context, identical to packages/queue/src/user-context.ts:

    base64url(JSON {userId, searchId, executionId, exp}) "." base64url(HMAC-SHA256(secret, part1))

The agent never trusts a bare user_id. The TypeScript worker signs the
authenticated owner of the search, this service verifies it, and the Fastify
internal API verifies it again (plus database ownership) on every private call.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


@dataclass(frozen=True, slots=True)
class UserContext:
    user_id: str
    search_id: str
    execution_id: str
    exp: int
    token: str


def sign_user_context(user_id: str, search_id: str, execution_id: str, exp: int, secret: str) -> str:
    payload = {"userId": user_id, "searchId": search_id, "executionId": execution_id, "exp": exp}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_user_context(token: str, secret: str, now: float | None = None) -> UserContext | None:
    parts = token.split(".")
    if len(parts) != 2 or not all(parts):
        return None
    body, sig = parts
    expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(_unb64(sig), expected):
            return None
        data = json.loads(_unb64(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    user_id, search_id, execution_id, exp = (
        data.get("userId"),
        data.get("searchId"),
        data.get("executionId"),
        data.get("exp"),
    )
    if not (isinstance(user_id, str) and isinstance(search_id, str) and isinstance(execution_id, str)):
        return None
    if isinstance(exp, bool) or not isinstance(exp, int | float):
        return None
    if exp < (time.time() if now is None else now):
        return None
    return UserContext(user_id, search_id, execution_id, int(exp), token)
