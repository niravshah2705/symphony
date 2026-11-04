"""Internal service-to-service surface (no end-user principal).

Mounted under ``/api/v1/internal/*``. Two guards, mirroring the settings
service's internal surface, plus a shared token because — unlike that surface —
these calls carry NO forwarded user token (the provisioner acts on its own):

1. The gateway refuses to proxy any ``/internal/`` path, so a browser can never
   route here.
2. The service is IAM-gated (Cloud Run ``--no-allow-unauthenticated``): only
   allowed service accounts can invoke it.
3. A shared ``X-Internal-Token`` (settings.internal_api_token) is required and
   compared in constant time; unset => refused (fail closed).

The org id is a route param here (the provisioner knows which org it just built),
which is safe because there is no user identity to scope against — the token IS
the authorization. Writes stay confined to the named org's deployments map, and
the one read here (``billing-context``) returns the org's identity plus its
administrator *emails*, which PII: it must stay IAM-gated and must never be
widened to passwords, hashes or membership beyond ORG_ADMIN.
"""
from __future__ import annotations

import hmac
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

from app.core.config import get_settings
from app.core.database import Uow, get_session
from app.core.timeutils import utcnow
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.org_repo import OrgRepository
from app.schemas.org import BillingAdmin, BillingContextResponse

router = APIRouter(prefix="/internal", tags=["internal"])


class DeploymentWriteback(BaseModel):
    """The provisioner's authoritative deployments map for an org."""

    deployments: dict


def require_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = get_settings().internal_api_token
    # Fail closed when unconfigured; constant-time compare otherwise.
    if not expected or not x_internal_token or not hmac.compare_digest(x_internal_token, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")


@router.patch("/orgs/{org_id}/deployments", status_code=status.HTTP_200_OK)
async def write_deployments(
    org_id: uuid.UUID,
    body: DeploymentWriteback,
    _: None = Depends(require_internal_token),
    session: Uow = Depends(get_session),
):
    """Persist the provisioner's deployments map onto the org (S2S write-back)."""
    org = await OrgRepository(session).get(org_id)
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="org not found")
    org.deployments = body.deployments if isinstance(body.deployments, dict) else {}
    org.updated_at = utcnow()
    return {"status": "ok", "org_id": str(org.id)}


@router.get("/orgs/{org_id}/billing-context", response_model=BillingContextResponse)
async def billing_context(
    org_id: uuid.UUID,
    _: None = Depends(require_internal_token),
    session: Uow = Depends(get_session),
):
    """Org identity + administrator emails for the auto-recharge job (S2S read)."""
    org = await OrgRepository(session).get(org_id)
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="org not found")
    admins = await OrganizationMembershipRepository(session).list_active_admins(org_id)
    return BillingContextResponse(
        id=org.id,
        name=org.name,
        slug=org.slug,
        deployment_slug=org.deployment_slug,
        admins=[
            BillingAdmin(user_id=u.id, email=u.email) for u in admins if u.email.strip()
        ],
    )
