"""Internal service-to-service endpoints (UNMASKED config values).

This surface returns provider secrets in PLAINTEXT and must never be reachable
from a browser. Two layers guard it:

1. It is mounted under ``/api/v1/internal/*``. The gateway is the only
   browser-facing origin and it refuses to proxy any ``/internal/`` path, so a
   browser can never route here (see services/gateway/src/index.js).
2. The service is IAM-gated: only the gateway/planner service accounts can
   invoke it at all (Cloud Run ``--no-allow-unauthenticated``).

Scope still derives from the AUTHENTICATED PRINCIPAL (the end-user's forwarded
token), never from caller-supplied org ids — identical scoping to the
browser-facing ``/effective`` endpoint, so a foreign project_id can never read
another org's data (cross-tenant-isolation).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query

from app.auth.dependencies import get_principal
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.schemas.policy import InternalEffectiveConfigResponse
from app.services import policy_service

router = APIRouter(prefix="/internal", tags=["internal"])


@router.get("/effective-config", response_model=InternalEffectiveConfigResponse)
async def get_effective_config(
    project_id: uuid.UUID | None = Query(default=None),
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    """Return the caller's UNMASKED effective config values (S2S only)."""
    return await policy_service.resolve_config_for_caller(session, principal, project_id)
