"""Org-admin connector routing metadata and readiness."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query

from app.authz.guards import require_org_admin
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.schemas.connectors import (
    ConnectorConfigResponse,
    ConnectorConfigUpdate,
    ConnectorReadinessResponse,
)
from app.services import connectors_service

router = APIRouter(prefix="/settings/org/connectors", tags=["connectors"])


@router.get("", response_model=ConnectorConfigResponse)
async def get_org_connectors(
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await connectors_service.get_org_connectors(session, principal)


@router.put("", response_model=ConnectorConfigResponse)
async def put_org_connectors(
    body: ConnectorConfigUpdate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await connectors_service.set_org_connectors(session, principal, body)


@router.get("/readiness", response_model=ConnectorReadinessResponse)
async def get_org_connectors_readiness(
    project_id: uuid.UUID | None = Query(default=None),
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await connectors_service.get_connector_readiness(
        session, principal, project_id
    )
