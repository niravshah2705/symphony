"""Auto-provisioned pseudo workspaces (onboarding_service.ensure_org_for_user).

An org-less signed-in user lazily gets a friendly "<name>'s Workspace" org on the
SHARED stack. Exercises name derivation, org creation + admin promotion,
idempotency (re-call returns the same org, never 409), and the one-org-per-user
lock that stops two concurrent first requests from each minting an org.
"""
from __future__ import annotations

import pytest

from app.core.database import new_uow
from app.models.enums import AuthProvider, OrgRole
from app.models.user import User
from app.repositories.base import ORGS, USER_ORG_LOCKS
from app.repositories.user_repo import UserRepository
from app.services import onboarding_service
from app.services.onboarding_service import derive_workspace_name, ensure_org_for_user


def _external_user(email: str, full_name: str | None) -> User:
    return User(
        email=email,
        org_id=None,
        full_name=full_name,
        auth_provider=AuthProvider.EXTERNAL,
        external_subject=f"google|{email}",
        email_verified=True,
    )


async def _persist(user: User) -> None:
    uow = new_uow()
    await UserRepository(uow).add(user)
    await uow.commit()


# --- derive_workspace_name (pure) -------------------------------------------

def test_workspace_name_prefers_first_token_of_full_name():
    assert derive_workspace_name(_external_user("nirav@corp.com", "Nirav Shah")) == "Nirav's Workspace"


def test_workspace_name_falls_back_to_email_local_part():
    assert derive_workspace_name(_external_user("jane.doe@corp.com", None)) == "jane.doe's Workspace"


def test_workspace_name_defaults_when_no_name_or_email():
    assert derive_workspace_name(User()) == "My's Workspace"


def test_workspace_name_is_bounded():
    long_name = "N" * 500
    name = derive_workspace_name(_external_user("x@y.com", long_name))
    assert name.endswith("'s Workspace")
    assert len(name) <= 200  # within the org-name max


# --- ensure_org_for_user -----------------------------------------------------

@pytest.mark.asyncio
async def test_creates_pseudo_org_and_promotes_admin(db_session):
    user = _external_user("New.User@corp.com", "New User")
    await _persist(user)

    uow = new_uow()
    loaded = await UserRepository(uow).get_by_id(user.id)
    org = await ensure_org_for_user(uow, loaded)
    await uow.commit()

    assert org is not None
    assert org.name == "New's Workspace"
    assert loaded.org_id == org.id
    assert loaded.org_role == OrgRole.ORG_ADMIN
    # deployment_slug derived; deployments empty → resolver returns the shared URL.
    assert org.deployment_slug.startswith("t") and len(org.deployment_slug) == 13
    assert org.deployments == {}


@pytest.mark.asyncio
async def test_is_idempotent_across_calls(db_session):
    user = _external_user("dup@corp.com", "Dup User")
    await _persist(user)

    uow1 = new_uow()
    u1 = await UserRepository(uow1).get_by_id(user.id)
    first = await ensure_org_for_user(uow1, u1)
    await uow1.commit()

    # Second call in a fresh unit of work returns the SAME org, never raises.
    uow2 = new_uow()
    u2 = await UserRepository(uow2).get_by_id(user.id)
    second = await ensure_org_for_user(uow2, u2)
    await uow2.commit()

    assert first.id == second.id
    # Exactly one org exists.
    orgs = await new_uow().db.query(ORGS)
    assert len(orgs) == 1


@pytest.mark.asyncio
async def test_returns_existing_org_without_new_lock(db_session):
    """A user who already belongs to an org just gets it back (no new mint)."""
    user = _external_user("member@corp.com", "Member")
    await _persist(user)
    uow1 = new_uow()
    u1 = await UserRepository(uow1).get_by_id(user.id)
    org = await ensure_org_for_user(uow1, u1)
    await uow1.commit()

    uow2 = new_uow()
    u2 = await UserRepository(uow2).get_by_id(user.id)
    again = await ensure_org_for_user(uow2, u2)
    assert again.id == org.id


@pytest.mark.asyncio
async def test_lock_loser_adopts_winner_org(db_session):
    """When the per-user lock is already held, the caller adopts that org id
    instead of minting a second org (the concurrency-loser path)."""
    user = _external_user("racer@corp.com", "Racer")
    await _persist(user)

    # Simulate the winner: create the org + claim the lock out-of-band.
    winner_uow = new_uow()
    from app.models.organization import Organization
    from app.services.common import allocate_org_slug

    org = Organization(name=derive_workspace_name(user), slug=await allocate_org_slug(winner_uow))
    await winner_uow.db.set(ORGS, str(org.id), org.to_doc())
    await winner_uow.db.create(USER_ORG_LOCKS, str(user.id), {"org_id": str(org.id)})

    uow = new_uow()
    loser = await UserRepository(uow).get_by_id(user.id)
    adopted = await ensure_org_for_user(uow, loser)
    await uow.commit()

    assert adopted.id == org.id
    assert loser.org_id == org.id
    # No second org was created.
    orgs = await new_uow().db.query(ORGS)
    assert len(orgs) == 1
