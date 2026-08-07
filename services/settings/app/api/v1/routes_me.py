"""User self-service settings (`/me/settings`).

Reachable by every signed-in user (including org-less JIT-provisioned Firebase
users). The user policy is always keyed by ``principal.user_id`` — never by a
path/body id — so cross-user access is structurally impossible.

At the gateway these are mounted at ``/api/settings-policy/me/*`` behind an
authentication-only gate (not an org role), mirroring how ``/api/org/me/*`` is
mounted ahead of the role-gated org surface.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.auth.dependencies import get_principal
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.schemas.policy import PolicyResponse, PolicyUpdate
from app.services import policy_service

router = APIRouter(prefix="/me", tags=["me"])


@router.get("/settings", response_model=PolicyResponse)
async def get_my_settings(
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await policy_service.get_user_policy(session, principal)


@router.put("/settings", response_model=PolicyResponse)
async def put_my_settings(
    body: PolicyUpdate,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await policy_service.set_user_policy(session, principal, body)
