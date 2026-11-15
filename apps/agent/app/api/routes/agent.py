"""Internal agent API (service-to-service only; never routed publicly).

POST /internal/agent/search                       start (idempotent per execution_id)
GET  /internal/agent/search/{execution_id}        status
POST /internal/agent/search/{execution_id}/cancel cancel at the next node boundary
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.api.dependencies.auth import require_service_token
from app.schemas.api import ExecutionStatusResponse, StartSearchRequest
from app.services.execution_service import ExecutionService, UserContextError

router = APIRouter(prefix="/internal/agent", dependencies=[Depends(require_service_token)], tags=["agent"])
_ID = re.compile(r"^[0-9a-f-]{36}$")


def _service(request: Request) -> ExecutionService:
    svc: ExecutionService = request.app.state.executions
    return svc


def _check_id(execution_id: str) -> None:
    if not _ID.match(execution_id):
        raise HTTPException(status_code=422, detail="Invalid execution id")


@router.post("/search", status_code=status.HTTP_202_ACCEPTED, response_model=ExecutionStatusResponse)
async def start_search(body: StartSearchRequest, request: Request) -> ExecutionStatusResponse:
    try:
        execution = await _service(request).start(body)
    except UserContextError as err:
        raise HTTPException(status_code=403, detail=str(err)) from err
    return execution.view()


@router.get("/search/{execution_id}", response_model=ExecutionStatusResponse)
async def get_status(execution_id: str, request: Request) -> ExecutionStatusResponse:
    _check_id(execution_id)
    found = await _service(request).status(execution_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Unknown execution")
    return found


@router.post("/search/{execution_id}/cancel", status_code=status.HTTP_202_ACCEPTED)
async def cancel(execution_id: str, request: Request) -> Response:
    _check_id(execution_id)
    if not _service(request).cancel(execution_id):
        raise HTTPException(status_code=404, detail="No running execution with this id")
    return Response(status_code=status.HTTP_202_ACCEPTED)
