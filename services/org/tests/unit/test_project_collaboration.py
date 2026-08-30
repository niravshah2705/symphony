"""Direct service/resolver unit tests for cross-org project collaboration.

Complements the HTTP integration suite (which the coverage tool can't trace
through the ASGI transport) with in-process calls that exercise the
authorization resolver, the invitation/grant services, persona capture,
pending-invite surfacing, and linked-identity dedup.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from app.authz.principal import Principal
from app.authz.project_access import resolve_project_access
from app.core.timeutils import utcnow
from app.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.models.enums import (
    InvitationStatus,
    OrgRole,
    Persona,
    ProjectAccessMode,
    ProjectRole,
)
from app.models.organization import Organization
from app.models.project import Project
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.models.user import User
from app.repositories import email_index
from app.repositories.base import PROJECT_OWNER_INDEX
from app.repositories.membership_repo import MembershipRepository
from app.repositories.org_repo import OrgRepository
from app.repositories.project_invitation_repo import ProjectInvitationRepository
from app.repositories.project_repo import ProjectRepository
from app.repositories.user_repo import UserRepository
from app.schemas.project_grant import ExternalGrantCreate
from app.schemas.project_invitation import ProjectInvitationCreate
from app.services import (
    me_service,
    project_external_grant_service,
    project_invitation_service,
    project_service,
    task_service,
)

pytestmark = pytest.mark.asyncio


async def _seed_org(session, name="Org") -> Organization:
    return await OrgRepository(session).add(
        Organization(name=name, slug=uuid.uuid4().hex[:12])
    )


async def _seed_project(session, org_id, name="P") -> Project:
    project = Project(org_id=org_id, name=name)
    project.tags = []
    return await ProjectRepository(session).add(project)


async def _seed_user(session, email, org_id=None) -> User:
    return await UserRepository(session).add(User(email=email, org_id=org_id))


def _principal(org_id, *, role=OrgRole.ORG_ADMIN, user_id=None) -> Principal:
    return Principal(
        user_id=user_id or uuid.uuid4(),
        org_id=org_id,
        org_role=role,
        is_super_admin=False,
        email="p@example.com",
    )


# ---- resolver: same-org paths ----------------------------------------------

async def test_resolver_org_admin_gets_project_admin(db_session):
    org = await _seed_org(db_session)
    project = await _seed_project(db_session, org.id)
    ctx = await resolve_project_access(
        db_session,
        user_id=uuid.uuid4(),
        org_id=org.id,
        org_role=OrgRole.ORG_ADMIN,
        project_id=project.id,
    )
    assert ctx is not None and ctx.role == ProjectRole.PROJECT_ADMIN


async def test_resolver_invite_only_denies_non_member(db_session):
    org = await _seed_org(db_session)
    project = await _seed_project(db_session, org.id)
    ctx = await resolve_project_access(
        db_session,
        user_id=uuid.uuid4(),
        org_id=org.id,
        org_role=OrgRole.MEMBER,
        project_id=project.id,
    )
    assert ctx is None


async def test_resolver_org_wide_grants_member_developer(db_session):
    org = await _seed_org(db_session)
    project = await _seed_project(db_session, org.id)
    await project_service.set_access_mode(db_session, project, ProjectAccessMode.ORG_WIDE)
    ctx = await resolve_project_access(
        db_session,
        user_id=uuid.uuid4(),
        org_id=org.id,
        org_role=OrgRole.MEMBER,
        project_id=project.id,
    )
    assert ctx is not None and ctx.role == ProjectRole.DEVELOPER


async def test_resolver_explicit_membership_role_wins(db_session):
    org = await _seed_org(db_session)
    project = await _seed_project(db_session, org.id)
    user_id = uuid.uuid4()
    await MembershipRepository(db_session).add(
        org.id,
        ProjectMembership(project_id=project.id, user_id=user_id, role=ProjectRole.TEAM_LEAD),
    )
    ctx = await resolve_project_access(
        db_session,
        user_id=user_id,
        org_id=org.id,
        org_role=OrgRole.MEMBER,
        project_id=project.id,
    )
    assert ctx is not None and ctx.role == ProjectRole.TEAM_LEAD


# ---- resolver: cross-org paths ---------------------------------------------

async def test_resolver_cross_org_membership(db_session):
    owner = await _seed_org(db_session, "Owner")
    home = await _seed_org(db_session, "Home")
    project = await _seed_project(db_session, owner.id)
    user_id = uuid.uuid4()
    # Membership under the OWNER org, carrying the member's home org.
    await MembershipRepository(db_session).add(
        owner.id,
        ProjectMembership(
            project_id=project.id,
            user_id=user_id,
            role=ProjectRole.DEVELOPER,
            member_org_id=home.id,
        ),
    )
    ctx = await resolve_project_access(
        db_session,
        user_id=user_id,
        org_id=home.id,
        org_role=OrgRole.MEMBER,
        project_id=project.id,
    )
    assert ctx is not None and ctx.role == ProjectRole.DEVELOPER


async def test_resolver_external_grant(db_session):
    owner = await _seed_org(db_session, "Owner")
    partner = await _seed_org(db_session, "Partner")
    project = await _seed_project(db_session, owner.id)
    await project_external_grant_service.create_external_grant(
        db_session,
        _principal(owner.id),
        project,
        ExternalGrantCreate(collaborator_org_id=partner.id, default_role=ProjectRole.TEAM_LEAD),
    )
    ctx = await resolve_project_access(
        db_session,
        user_id=uuid.uuid4(),
        org_id=partner.id,
        org_role=OrgRole.MEMBER,
        project_id=project.id,
    )
    assert ctx is not None and ctx.role == ProjectRole.TEAM_LEAD


async def test_resolver_unrelated_org_denied(db_session):
    owner = await _seed_org(db_session, "Owner")
    outsider = await _seed_org(db_session, "Outsider")
    project = await _seed_project(db_session, owner.id)
    ctx = await resolve_project_access(
        db_session,
        user_id=uuid.uuid4(),
        org_id=outsider.id,
        org_role=OrgRole.ORG_ADMIN,
        project_id=project.id,
    )
    assert ctx is None


async def test_resolver_unknown_project_denied(db_session):
    org = await _seed_org(db_session)
    ctx = await resolve_project_access(
        db_session,
        user_id=uuid.uuid4(),
        org_id=org.id,
        org_role=OrgRole.ORG_ADMIN,
        project_id=uuid.uuid4(),
    )
    assert ctx is None


# ---- external grant service validations ------------------------------------

async def test_external_grant_rejects_self_and_missing_and_duplicate(db_session):
    owner = await _seed_org(db_session, "Owner")
    partner = await _seed_org(db_session, "Partner")
    project = await _seed_project(db_session, owner.id)
    principal = _principal(owner.id)

    with pytest.raises(ValidationAppError):
        await project_external_grant_service.create_external_grant(
            db_session, principal, project,
            ExternalGrantCreate(collaborator_org_id=owner.id),
        )
    # An org-wide grant may not confer PROJECT_ADMIN (least privilege).
    with pytest.raises(ValidationAppError):
        await project_external_grant_service.create_external_grant(
            db_session, principal, project,
            ExternalGrantCreate(
                collaborator_org_id=partner.id, default_role=ProjectRole.PROJECT_ADMIN
            ),
        )
    with pytest.raises(NotFoundError):
        await project_external_grant_service.create_external_grant(
            db_session, principal, project,
            ExternalGrantCreate(collaborator_org_id=uuid.uuid4()),
        )
    await project_external_grant_service.create_external_grant(
        db_session, principal, project,
        ExternalGrantCreate(collaborator_org_id=partner.id),
    )
    with pytest.raises(ConflictError):
        await project_external_grant_service.create_external_grant(
            db_session, principal, project,
            ExternalGrantCreate(collaborator_org_id=partner.id),
        )
    grants = await project_external_grant_service.list_external_grants(db_session, project)
    assert len(grants) == 1
    await project_external_grant_service.revoke_external_grant(db_session, project, partner.id)
    assert await project_external_grant_service.list_external_grants(db_session, project) == []


# ---- project invitation service --------------------------------------------

async def test_project_invitation_accept_creates_cross_org_membership(db_session, monkeypatch):
    owner = await _seed_org(db_session, "Owner")
    home = await _seed_org(db_session, "Home")
    project = await _seed_project(db_session, owner.id)
    bob = await _seed_user(db_session, "bob@partner.com", org_id=home.id)

    monkeypatch.setattr(
        project_invitation_service, "generate_invitation_token", lambda: "proj-token-1"
    )
    await project_invitation_service.create_project_invitation(
        db_session, _principal(owner.id), project,
        ProjectInvitationCreate(email="bob@partner.com", role=ProjectRole.DEVELOPER),
    )
    result = await project_invitation_service.accept_project_invitation(
        db_session, bob, "proj-token-1"
    )
    assert result["membership"]["member_org_id"] == home.id
    # The resulting membership is resolvable cross-org.
    ctx = await resolve_project_access(
        db_session,
        user_id=bob.id,
        org_id=home.id,
        org_role=OrgRole.MEMBER,
        project_id=project.id,
    )
    assert ctx is not None and ctx.role == ProjectRole.DEVELOPER


async def test_project_invitation_wrong_email_forbidden(db_session, monkeypatch):
    owner = await _seed_org(db_session, "Owner")
    project = await _seed_project(db_session, owner.id)
    other = await _seed_user(db_session, "other@x.com")
    monkeypatch.setattr(
        project_invitation_service, "generate_invitation_token", lambda: "proj-token-2"
    )
    await project_invitation_service.create_project_invitation(
        db_session, _principal(owner.id), project,
        ProjectInvitationCreate(email="invited@x.com"),
    )
    with pytest.raises(ForbiddenError):
        await project_invitation_service.accept_project_invitation(
            db_session, other, "proj-token-2"
        )


async def test_project_invitation_duplicate_pending_conflicts(db_session, monkeypatch):
    owner = await _seed_org(db_session, "Owner")
    project = await _seed_project(db_session, owner.id)
    tokens = iter(["t-a", "t-b"])
    monkeypatch.setattr(
        project_invitation_service, "generate_invitation_token", lambda: next(tokens)
    )
    await project_invitation_service.create_project_invitation(
        db_session, _principal(owner.id), project,
        ProjectInvitationCreate(email="dup@x.com"),
    )
    with pytest.raises(ConflictError):
        await project_invitation_service.create_project_invitation(
            db_session, _principal(owner.id), project,
            ProjectInvitationCreate(email="dup@x.com"),
        )


async def test_project_invitation_list_and_revoke(db_session, monkeypatch):
    owner = await _seed_org(db_session, "Owner")
    project = await _seed_project(db_session, owner.id)
    monkeypatch.setattr(
        project_invitation_service, "generate_invitation_token", lambda: "list-token"
    )
    created = await project_invitation_service.create_project_invitation(
        db_session, _principal(owner.id), project,
        ProjectInvitationCreate(email="listed@x.com"),
    )
    listed = await project_invitation_service.list_project_invitations(db_session, project)
    assert len(listed) == 1 and listed[0]["email"] == "listed@x.com"

    await project_invitation_service.revoke_project_invitation(
        db_session, project, created["id"]
    )
    remaining = await project_invitation_service.list_project_invitations(db_session, project)
    assert remaining[0]["status"] == InvitationStatus.REVOKED
    # Revoking again is a conflict; an unknown id is a 404.
    with pytest.raises(ConflictError):
        await project_invitation_service.revoke_project_invitation(
            db_session, project, created["id"]
        )
    with pytest.raises(NotFoundError):
        await project_invitation_service.revoke_project_invitation(
            db_session, project, uuid.uuid4()
        )


async def test_project_invitation_expired_accept_conflicts(db_session):
    owner = await _seed_org(db_session, "Owner")
    project = await _seed_project(db_session, owner.id)
    bob = await _seed_user(db_session, "bob@x.com")
    # Seed a directly-expired invitation via the repository.
    repo = ProjectInvitationRepository(db_session)
    from app.core.security import hash_token

    await repo.add(
        ProjectInvitation(
            project_id=project.id,
            org_id=owner.id,
            email="bob@x.com",
            token_hash=hash_token("expired-token"),
            expires_at=utcnow() - timedelta(days=1),
        )
    )
    with pytest.raises(ConflictError):
        await project_invitation_service.accept_project_invitation(
            db_session, bob, "expired-token"
        )


async def test_project_delete_cascades_collaboration_records(db_session, monkeypatch):
    owner = await _seed_org(db_session, "Owner")
    partner = await _seed_org(db_session, "Partner")
    project = await _seed_project(db_session, owner.id)
    monkeypatch.setattr(
        project_invitation_service, "generate_invitation_token", lambda: "cascade-token"
    )
    await project_invitation_service.create_project_invitation(
        db_session, _principal(owner.id), project,
        ProjectInvitationCreate(email="cascade@x.com"),
    )
    await project_external_grant_service.create_external_grant(
        db_session, _principal(owner.id), project,
        ExternalGrantCreate(collaborator_org_id=partner.id),
    )
    await db_session.commit()

    # Owner index + email index entry exist before delete.
    assert await db_session.get(PROJECT_OWNER_INDEX, str(project.id)) is not None
    assert await email_index.get_entries(db_session.db, "cascade@x.com")

    await ProjectRepository(db_session).delete(project)

    # …and are cleaned up after.
    assert await db_session.get(PROJECT_OWNER_INDEX, str(project.id)) is None
    assert await email_index.get_entries(db_session.db, "cascade@x.com") == []
    assert (
        await project_external_grant_service.list_external_grants(db_session, project) == []
    )


# ---- persona + pending-invite surfacing ------------------------------------

async def test_set_persona(db_session):
    user = await _seed_user(db_session, "p@x.com")
    updated = await me_service.set_persona(db_session, user, Persona.CLIENT)
    assert updated.persona == Persona.CLIENT


async def test_pending_invitations_surface_and_clear(db_session, monkeypatch):
    owner = await _seed_org(db_session, "Owner")
    project = await _seed_project(db_session, owner.id)
    invitee = await _seed_user(db_session, "surfaced@x.com")
    monkeypatch.setattr(
        project_invitation_service, "generate_invitation_token", lambda: "surf-token"
    )
    await project_invitation_service.create_project_invitation(
        db_session, _principal(owner.id), project,
        ProjectInvitationCreate(email="surfaced@x.com"),
    )
    pending = await me_service.list_pending_invitations(db_session, invitee)
    assert len(pending) == 1
    assert pending[0]["kind"] == "project"
    assert pending[0]["project_name"] == "P"

    await project_invitation_service.accept_project_invitation(
        db_session, invitee, "surf-token"
    )
    assert await me_service.list_pending_invitations(db_session, invitee) == []


# ---- linked-identity dedup --------------------------------------------------

async def test_link_identity_dedup_and_conflicts(db_session):
    repo = UserRepository(db_session)
    primary = await _seed_user(db_session, "person@x.com")
    await repo.link_identity(primary, "microsoft.com", "ms-subject-1")
    await db_session.commit()

    resolved = await repo.get_by_linked_identity("microsoft.com", "ms-subject-1")
    assert resolved is not None and resolved.id == primary.id

    # Same identity cannot be linked twice.
    with pytest.raises(ConflictError):
        await repo.link_identity(primary, "microsoft.com", "ms-subject-1")


async def test_link_identity_service_verifies_token(db_session, monkeypatch):
    user = await _seed_user(db_session, "person@x.com")
    user.external_subject = "primary-sub"
    monkeypatch.setattr(me_service, "get_unverified_issuer", lambda t: "https://issuer")
    monkeypatch.setattr(me_service, "is_idp_issuer", lambda iss: True)
    monkeypatch.setattr(
        me_service,
        "decode_idp_token",
        lambda t: {
            "sub": "ms-sub",
            "email_verified": True,
            "firebase": {"sign_in_provider": "microsoft.com"},
        },
    )
    identity = await me_service.link_identity(db_session, user, "tok")
    assert identity.provider == "microsoft.com" and identity.subject == "ms-sub"
    # A later sign-in via the linked identity resolves back to this account.
    resolved = await UserRepository(db_session).get_by_linked_identity("microsoft.com", "ms-sub")
    assert resolved is not None and resolved.id == user.id

    # Linking the account's own primary identity is rejected.
    monkeypatch.setattr(
        me_service,
        "decode_idp_token",
        lambda t: {"sub": "primary-sub", "email_verified": True},
    )
    with pytest.raises(ValidationAppError):
        await me_service.link_identity(db_session, user, "tok")


async def test_task_tags_scoped_to_project_owner_org(db_session):
    from app.models.tag import Tag
    from app.repositories.tag_repo import TagRepository
    from app.schemas.task import TaskCreate

    owner = await _seed_org(db_session, "Owner")
    other = await _seed_org(db_session, "Other")
    project = await _seed_project(db_session, owner.id)
    owner_tag = await TagRepository(db_session).add(Tag(org_id=owner.id, name="o"))
    other_tag = await TagRepository(db_session).add(Tag(org_id=other.id, name="x"))

    # A tag from the project's OWNER org attaches.
    task = await task_service.create_task(
        db_session, project, TaskCreate(title="T", tag_ids=[owner_tag.id])
    )
    assert len(task.tags) == 1
    # A tag from a DIFFERENT org is rejected — scoping is by project.org_id, not
    # the caller's org (cross-tenant isolation).
    with pytest.raises(ValidationAppError):
        await task_service.create_task(
            db_session, project, TaskCreate(title="T2", tag_ids=[other_tag.id])
        )
