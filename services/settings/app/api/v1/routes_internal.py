"""Internal service-to-service endpoints (UNMASKED secrets).

This surface returns provider secrets in PLAINTEXT and must never be reachable
from a browser. Two families live here, guarded differently:

``/internal/effective-config`` — PRINCIPAL-SCOPED. Called by the gateway/planner
WITH the end-user's forwarded token; scope derives from that principal (never a
caller-supplied org id), identical to the browser-facing ``/effective`` endpoint.
Guards: the gateway refuses to proxy any ``/internal/`` path (browser can't route
here) + Cloud Run IAM (only allowed SAs invoke).

``/internal/s2s/*`` — TOKEN-SCOPED (no user principal). Called by the egress
proxy, which acts for an ORG and carries no end-user token. Guards add a shared
``X-Internal-Token`` (constant-time compare; unset => refused, fail closed). The
org id is a route param, safe because the token IS the authorization and the
read is confined to the named org's vault (mirrors the org service's write-back).
The auth middleware exempts ``/internal/s2s/*`` from the user-token requirement
(app/middleware/auth.py); ``/internal/effective-config`` still requires it.
"""
from __future__ import annotations

import hmac
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.auth.dependencies import get_principal
from app.authz.principal import Principal
from app.core.config import get_settings
from app.core.database import Uow, get_session
from app.schemas.policy import (
    InternalEffectiveConfigResponse,
    InternalEffectivePolicyResponse,
)
from app.schemas.secrets import InternalOrgSecretsResponse
from app.services import policy_service, secrets_service

router = APIRouter(prefix="/internal", tags=["internal"])


@router.get("/effective-config", response_model=InternalEffectiveConfigResponse)
async def get_effective_config(
    project_id: uuid.UUID | None = Query(default=None),
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    """Return the caller's UNMASKED effective config values (S2S only)."""
    return await policy_service.resolve_config_for_caller(session, principal, project_id)


def require_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = get_settings().internal_api_token
    # Fail closed when unconfigured; constant-time compare otherwise.
    if not expected or not x_internal_token or not hmac.compare_digest(x_internal_token, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")


@router.get("/s2s/orgs/{org_id}/secrets", response_model=InternalOrgSecretsResponse)
async def resolve_org_secrets(
    org_id: uuid.UUID,
    _: None = Depends(require_internal_token),
    session: Uow = Depends(get_session),
):
    """Return an org's UNMASKED resolved provider secrets for the egress proxy
    (token-gated S2S; no user principal)."""
    return await secrets_service.resolve_secrets_for_org(session, org_id)


@router.get("/s2s/managed-secrets", response_model=InternalOrgSecretsResponse)
async def resolve_managed_secrets(
    _: None = Depends(require_internal_token),
):
    """Return the platform-managed provider keys with NO org (shared stack). Same
    shape as the per-org resolve so the proxy uses one path."""
    return await secrets_service.resolve_managed_secrets()


@router.get(
    "/s2s/orgs/{org_id}/effective-policy",
    response_model=InternalEffectivePolicyResponse,
)
async def resolve_org_effective_policy(
    org_id: uuid.UUID,
    project_id: uuid.UUID | None = Query(default=None),
    _: None = Depends(require_internal_token),
    session: Uow = Depends(get_session),
):
    """Return an org's effective policy (org → project cascade, NO user scope) for
    the autonomous planner/coder (token-gated S2S; no user principal). The org_id
    route param is the authorization scope, safe because the shared token IS the
    authorization and the read is confined to the named org (mirrors the org
    secrets S2S resolver)."""
    return await policy_service.resolve_policy_for_org(session, org_id, project_id)
