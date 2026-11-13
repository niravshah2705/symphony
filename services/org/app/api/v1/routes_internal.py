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
the authorization. Writes stay confined to the named org — its ``deployments``
map and the step records of its own environment runs — and the one read here
(``billing-context``) returns the org's identity plus its administrator
*emails*, which PII: it must stay IAM-gated and must never be widened to
passwords, hashes or membership beyond ORG_ADMIN.
"""
from __future__ import annotations

import hmac
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, field_validator

from app.core.config import get_settings
from app.core.database import Uow, get_session
from app.core.timeutils import utcnow
from app.models.enums import EnvironmentStepStatus
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.org_repo import OrgRepository
from app.schemas.org import BillingAdmin, BillingContextResponse
from app.services import environment_service

router = APIRouter(prefix="/internal", tags=["internal"])


class DeploymentWriteback(BaseModel):
    """The provisioner's authoritative deployments map for an org."""

    deployments: dict


# A step answer can only settle a step. `pending`/`running` are the org service's
# own states (it sets `running` when it publishes the request); letting the
# provisioner write them back would let a slow worker rewind work that is done.
_STEP_ANSWERS = (
    EnvironmentStepStatus.COMPLETED,
    EnvironmentStepStatus.FAILED,
    EnvironmentStepStatus.SKIPPED,
)


class StepStatusWriteback(BaseModel):
    """One asynchronous environment-init step's outcome."""

    status: EnvironmentStepStatus
    detail: dict | None = None

    @field_validator("status")
    @classmethod
    def _settle_only(cls, value: EnvironmentStepStatus) -> EnvironmentStepStatus:
        if value not in _STEP_ANSWERS:
            raise ValueError(f"step answer must be one of {[s.value for s in _STEP_ANSWERS]}")
        return value


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


@router.patch(
    "/orgs/{org_id}/environment_runs/{run_id}/steps/{step_key}",
    status_code=status.HTTP_200_OK,
)
async def write_step_status(
    org_id: uuid.UUID,
    run_id: uuid.UUID,
    step_key: str,
    body: StepStatusWriteback,
    _: None = Depends(require_internal_token),
    session: Uow = Depends(get_session),
):
    """Settle one environment-init step the init job handed to the provisioner.

    The provisioner reports on a step it was *asked* about (`substrate.atespace`);
    it does not own the status machine, and the only thing it can say is how the
    work it did turned out. An unknown run or step key is one 404: the ids are
    addressed under the org path, and refusing to distinguish them is what keeps
    the surface from confirming which ids are real.
    """
    try:
        run = await environment_service.set_step_status(
            session,
            org_id,
            run_id,
            step_key=step_key,
            status=body.status.value,
            detail=body.detail,
        )
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="step not found")
    return {"status": "ok", "run_id": str(run.id), "run_status": run.status.value}


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
        is_default=org.is_default,
        admins=[
            BillingAdmin(user_id=u.id, email=u.email) for u in admins if u.email.strip()
        ],
    )
