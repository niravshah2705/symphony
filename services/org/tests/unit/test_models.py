"""Round-trip tests for the Firestore-backed dataclass models: `to_doc()` then
`from_doc()` reproduces the original, and a doc missing the newer fields
(simulating an old, pre-migration document) still loads with the documented
defaults.
"""
from __future__ import annotations

import uuid

from app.models.enums import (
    InvitationStatus,
    Persona,
    ProjectAccessMode,
    ProjectRole,
)
from app.models.organization import Organization
from app.models.project import Project
from app.models.project_external_grant import ProjectExternalOrgGrant
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.models.user import LinkedIdentity, User


def test_user_round_trip_with_persona_and_linked_identities():
    user = User(
        email="engineer@example.com",
        persona=Persona.ENGINEER,
        linked_identities=[LinkedIdentity(provider="microsoft", subject="sso-123")],
    )
    loaded = User.from_doc(user.to_doc())
    assert loaded == user


def test_user_from_doc_defaults_persona_and_linked_identities_when_missing():
    user = User(email="legacy@example.com")
    doc = user.to_doc()
    del doc["persona"]
    del doc["linked_identities"]
    loaded = User.from_doc(doc)
    assert loaded.persona is None
    assert loaded.linked_identities == []


def test_organization_round_trip_with_domains_and_parent():
    parent_id = uuid.uuid4()
    org = Organization(name="Acme", domains=["acme.com", "acme.io"], parent_org_id=parent_id)
    loaded = Organization.from_doc(org.to_doc())
    assert loaded.domains == ["acme.com", "acme.io"]
    assert loaded.parent_org_id == parent_id


def test_organization_from_doc_defaults_domains_and_parent_when_missing():
    org = Organization(name="Acme")
    doc = org.to_doc()
    del doc["domains"]
    del doc["parent_org_id"]
    loaded = Organization.from_doc(doc)
    assert loaded.domains == []
    assert loaded.parent_org_id is None


def test_project_round_trip_with_access_mode():
    project = Project(org_id=uuid.uuid4(), name="Widgets", access_mode=ProjectAccessMode.ORG_WIDE)
    loaded = Project.from_doc(project.to_doc())
    assert loaded.access_mode == ProjectAccessMode.ORG_WIDE


def test_project_from_doc_defaults_access_mode_when_missing():
    project = Project(org_id=uuid.uuid4(), name="Widgets")
    doc = project.to_doc()
    del doc["access_mode"]
    loaded = Project.from_doc(doc)
    assert loaded.access_mode == ProjectAccessMode.INVITE_ONLY


def test_project_membership_round_trip_with_member_org_id():
    member_org_id = uuid.uuid4()
    membership = ProjectMembership(
        project_id=uuid.uuid4(), user_id=uuid.uuid4(), member_org_id=member_org_id
    )
    loaded = ProjectMembership.from_doc(membership.to_doc())
    assert loaded.member_org_id == member_org_id


def test_project_membership_from_doc_defaults_member_org_id_when_missing():
    membership = ProjectMembership(project_id=uuid.uuid4(), user_id=uuid.uuid4())
    doc = membership.to_doc()
    del doc["member_org_id"]
    loaded = ProjectMembership.from_doc(doc)
    assert loaded.member_org_id is None


def test_project_invitation_round_trip():
    invitation = ProjectInvitation(
        project_id=uuid.uuid4(),
        org_id=uuid.uuid4(),
        email="freelancer@gmail.com",
        role=ProjectRole.DEVELOPER,
        status=InvitationStatus.PENDING,
        token_hash="hash",
    )
    loaded = ProjectInvitation.from_doc(invitation.to_doc())
    assert loaded == invitation


def test_project_external_org_grant_round_trip():
    grant = ProjectExternalOrgGrant(
        project_id=uuid.uuid4(),
        owner_org_id=uuid.uuid4(),
        collaborator_org_id=uuid.uuid4(),
        default_role=ProjectRole.TEAM_LEAD,
    )
    loaded = ProjectExternalOrgGrant.from_doc(grant.to_doc())
    assert loaded == grant
