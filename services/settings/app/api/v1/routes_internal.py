"""Internal service-to-service endpoints (UNMASKED secrets).

This surface returns provider secrets in PLAINTEXT and must never be reachable
from a browser. Two families live here, guarded differently:

``/internal/effective-config`` — PRINCIPAL-SCOPED. Called by the gateway/planner
WITH the end-user's forwarded token; scope derives from that principal (never a
caller-supplied org id), identical to the browser-facing ``/effective`` endpoint.
Guards: the gateway refuses to proxy any ``/internal/`` path (browser can't route
here) + Cloud Run IAM (only allowed SAs invoke).

``/internal/s2s/*`` — TOKEN-SCOPED (no user principal). Shared, secret-free
control calls use ``X-Internal-Token``. Plaintext organization credential reads
and Codex rotation require ``X-Org-Internal-Token``, an HMAC-derived bearer
bound to the path organization and issued only to that tenant's proxy sidecar.
Both guards compare in constant time and fail closed when unconfigured.
The auth middleware exempts ``/internal/s2s/*`` from the user-token requirement
(app/middleware/auth.py); ``/internal/effective-config`` still requires it.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.auth.dependencies import get_principal
from app.authz.principal import Principal
from app.core.config import get_settings
from app.core.database import Uow, get_session
from app.errors import NotFoundError
from app.schemas.policy import (
    InternalEffectiveConfigResponse,
    InternalEffectivePolicyResponse,
)
from app.schemas.secrets import InternalOrgSecretsResponse
from app.schemas.codex_tokens import CodexTokenRotateRequest, CodexTokenRotateResponse
from app.schemas.deployment_approval import (
    DeploymentApprovalConsumeRequest,
    DeploymentApprovalResponse,
    validate_run_id,
)
from app.errors import ValidationAppError
from app.services import deployment_approval_service, policy_service, secrets_service

router = APIRouter(prefix="/internal", tags=["internal"])


@router.get("/effective-config", response_model=InternalEffectiveConfigResponse)
async def get_effective_config(
    project_id: uuid.UUID | None = Query(default=None),
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    """Return the caller's UNMASKED effective config values (S2S only)."""
    if principal.context_authoritative and principal.project_id is None and project_id is not None:
        raise NotFoundError("Project not found")
    if principal.project_id is not None and project_id is not None and principal.project_id != project_id:
        raise NotFoundError("Project not found")
    if project_id is None:
        project_id = principal.project_id
    return await policy_service.resolve_config_for_caller(session, principal, project_id)


def require_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = get_settings().internal_api_token
    # Fail closed when unconfigured; constant-time compare otherwise.
    if not expected or not x_internal_token or not hmac.compare_digest(x_internal_token, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")


_ORG_TOKEN_CONTEXT = b"ai-fleet-org-s2s-v1\x00"


def derive_org_internal_token(org_id: uuid.UUID) -> str:
    key = get_settings().org_s2s_signing_key
    if not key:
        return ""
    digest = hmac.new(
        key.encode("utf-8"),
        _ORG_TOKEN_CONTEXT + str(org_id).encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def require_org_internal_token(
    org_id: uuid.UUID,
    x_org_internal_token: str | None = Header(
        default=None, alias="X-Org-Internal-Token"
    ),
) -> None:
    expected = derive_org_internal_token(org_id)
    if (
        not expected
        or not x_org_internal_token
        or not hmac.compare_digest(x_org_internal_token, expected)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")


@router.get("/s2s/orgs/{org_id}/secrets", response_model=InternalOrgSecretsResponse)
async def resolve_org_secrets(
    org_id: uuid.UUID,
    _: None = Depends(require_org_internal_token),
    session: Uow = Depends(get_session),
):
    """Return an org's UNMASKED resolved provider secrets for the egress proxy
    (organization-bound token-gated S2S; no user principal)."""
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


@router.put(
    "/s2s/orgs/{org_id}/codex-tokens",
    response_model=CodexTokenRotateResponse,
)
async def rotate_org_codex_tokens(
    org_id: uuid.UUID,
    body: CodexTokenRotateRequest,
    _: None = Depends(require_org_internal_token),
    session: Uow = Depends(get_session),
):
    """Atomically persist proxy-refreshed rotation; never browser reachable."""
    return await secrets_service.rotate_codex_tokens(session, org_id, body)


@router.post(
    "/s2s/orgs/{org_id}/deployment-approvals/{run_id}/consume",
    response_model=DeploymentApprovalResponse,
)
async def consume_deployment_approval(
    org_id: uuid.UUID,
    run_id: str,
    body: DeploymentApprovalConsumeRequest,
    _: None = Depends(require_internal_token),
    session: Uow = Depends(get_session),
):
    """Atomically consume (or idempotently replay) a post-test approval."""
    try:
        normalized_run_id = validate_run_id(run_id)
    except ValueError as exc:
        raise ValidationAppError(str(exc)) from exc
    return await deployment_approval_service.consume(
        session, org_id, normalized_run_id, body
    )
