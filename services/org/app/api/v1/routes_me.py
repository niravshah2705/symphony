"""Self-service surface for any authenticated user (`/me`).

Reachable by every signed-in user, including those who belong to no organization
(JIT-provisioned Firebase users with ``org_id=None``). Two capabilities:

- **Personal projects** — single-owner projects scoped to the caller
  (``principal.user_id``); cross-user access is impossible (structural path
  isolation) and missing loads return 404.
- **Create organization** — any authenticated caller creates another org and
  becomes its first ORG_ADMIN, unlocking that selected tenant surface.

At the gateway these are mounted at ``/api/org/me/*`` behind an
authentication-only gate (not the ``org`` role), because personal workspace is
available to everyone signed in; org authorization still applies to the tenant
routes. The service layer enforces owner-scoping regardless of the gateway.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from app.api.deps import page_params
from app.auth.dependencies import get_current_user, get_principal
from app.authz.principal import Principal
from app.core.config import get_settings
from app.core.database import Uow, get_session
from app.models.user import User
from app.schemas.common import Page, PageParams
from app.schemas.me import (
    CreateOrgRequest,
    EnvironmentRetryRequest,
    LinkedIdentityResponse,
    LinkIdentityRequest,
    MeContextResponse,
    MeDeploymentResponse,
    MeEnvironmentResponse,
    MeEnvironmentStepResponse,
    MeResponse,
    PendingInvitationResponse,
    PersonaUpdate,
    PersonalProjectResponse,
)
from app.schemas.org import OrgResponse
from app.schemas.project import ProjectCreate, ProjectUpdate
from app.services import (
    context_service,
    environment_service,
    me_service,
    onboarding_service,
    personal_project_service,
)

router = APIRouter(prefix="/me", tags=["me"])


@router.get("", response_model=MeResponse)
async def get_me(
    user: User = Depends(get_current_user),
    principal: Principal = Depends(get_principal),
):
    return MeResponse(
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        persona=user.persona,
        has_organization=principal.org_id is not None,
        org_id=principal.org_id,
        org_role=principal.org_role.value if principal.org_id is not None else None,
    )


@router.put("/persona", response_model=MeResponse)
async def set_my_persona(
    body: PersonaUpdate,
    user: User = Depends(get_current_user),
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    updated = await me_service.set_persona(session, user, body.persona)
    return MeResponse(
        user_id=updated.id,
        email=updated.email,
        full_name=updated.full_name,
        persona=updated.persona,
        has_organization=principal.org_id is not None,
        org_id=principal.org_id,
        org_role=principal.org_role.value if principal.org_id is not None else None,
    )


@router.get("/pending-invitations", response_model=list[PendingInvitationResponse])
async def list_my_pending_invitations(
    user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
):
    return await me_service.list_pending_invitations(session, user)


@router.post(
    "/linked-identities",
    response_model=LinkedIdentityResponse,
    status_code=status.HTTP_201_CREATED,
)
async def link_my_identity(
    body: LinkIdentityRequest,
    user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
):
    return await me_service.link_identity(session, user, body.token)


@router.get("/context", response_model=MeContextResponse)
async def get_my_context(
    principal: Principal = Depends(get_principal),
    user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
):
    return await context_service.get_context(session, principal, user)


@router.get("/deployment", response_model=MeDeploymentResponse)
async def get_my_deployment(
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    """Resolve which front-facing gateway the caller's workspace should use.

    The org comes from the authenticated principal, never from a request-supplied
    id — see `me_service.resolve_deployment` for the isolation reasoning.
    """
    return await me_service.resolve_deployment(session, principal)


@router.get("/environment", response_model=MeEnvironmentResponse)
async def get_my_environment(
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    """The caller's deployment plus how far its environment initialization got.

    `deployment` is embedded (not re-derived) because the SPA already polls it:
    one implementation, so the two readings of the same fact cannot disagree.
    The org is the principal's own, so a caller can never observe another
    tenant's run — and an org-less caller sees the shared deployment with no run.
    """
    deployment = await me_service.resolve_deployment(session, principal)
    response = MeEnvironmentResponse(
        deployment=deployment,
        initialized=get_settings().environment_init_enabled,
    )
    if principal.org_id is None:
        return response
    run = await environment_service.latest_run(session, principal.org_id)
    if run is None:
        return response
    return MeEnvironmentResponse(
        deployment=deployment,
        initialized=response.initialized,
        run_id=run.id,
        status=run.status.value,
        desired_revision=run.desired_revision,
        attempted_revision=run.attempted_revision,
        trigger=run.trigger.value,
        steps=[MeEnvironmentStepResponse(**record) for record in run.steps],
    )


@router.post("/environment/retry", response_model=MeEnvironmentResponse)
async def retry_my_environment(
    body: EnvironmentRetryRequest,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    """Re-run one initialization step, or every unfinished one when `step` is
    omitted. Synchronous on purpose: the caller clicked it, so they get the
    outcome rather than a second poll target.

    404 when there is no run to retry — an org-less caller, or initialization
    switched off for this deployment. Not a 200 with an empty body: a retry that
    silently retried nothing would read as a fix.
    """
    if principal.org_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no environment run to retry")
    try:
        run = await environment_service.retry(session, principal.org_id, body.step)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no environment run to retry")
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no environment run to retry")
    deployment = await me_service.resolve_deployment(session, principal)
    return MeEnvironmentResponse(
        deployment=deployment,
        initialized=True,
        run_id=run.id,
        status=run.status.value,
        desired_revision=run.desired_revision,
        attempted_revision=run.attempted_revision,
        trigger=run.trigger.value,
        steps=[MeEnvironmentStepResponse(**record) for record in run.steps],
    )


@router.post("/organization", response_model=OrgResponse, status_code=status.HTTP_201_CREATED)
@router.post("/organizations", response_model=OrgResponse, status_code=status.HTTP_201_CREATED)
async def create_my_organization(
    body: CreateOrgRequest,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
):
    return await onboarding_service.create_organization_for_user(
        session, user, body, background=background
    )


@router.get("/projects", response_model=Page[PersonalProjectResponse])
async def list_my_projects(
    principal: Principal = Depends(get_principal),
    params: PageParams = Depends(page_params),
    session: Uow = Depends(get_session),
):
    rows, total = await personal_project_service.list_personal_projects(session, principal, params)
    return Page(data=rows, meta={"total": total, "page": params.page, "limit": params.limit})


@router.post("/projects", response_model=PersonalProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_my_project(
    body: ProjectCreate,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await personal_project_service.create_personal_project(session, principal, body)


@router.get("/projects/{project_id}", response_model=PersonalProjectResponse)
async def get_my_project(
    project_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await personal_project_service.get_personal_project(session, principal, project_id)


@router.patch("/projects/{project_id}", response_model=PersonalProjectResponse)
async def update_my_project(
    project_id: uuid.UUID,
    body: ProjectUpdate,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    project = await personal_project_service.get_personal_project(session, principal, project_id)
    return await personal_project_service.update_personal_project(session, project, body)


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_project(
    project_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
) -> None:
    project = await personal_project_service.get_personal_project(session, principal, project_id)
    await personal_project_service.delete_personal_project(session, project)
