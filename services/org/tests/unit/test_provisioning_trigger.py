"""provisioning_service.trigger_provisioning — the org-side provision trigger.

OFF by default (no status change, no publish); when enabled it marks the org
provisioning and publishes exactly one request, idempotently.
"""
from __future__ import annotations

import pytest

from app.core.config import get_settings
from app.core.database import new_uow
from app.models.organization import Organization
from app.repositories.org_repo import OrgRepository
from app.services import provisioning_service


async def _make_org() -> tuple[object, Organization]:
    uow = new_uow()
    org = Organization(name="Acme", slug="opaqueslug1")
    await OrgRepository(uow).add(org)
    return uow, org


@pytest.mark.asyncio
async def test_noop_when_provisioning_disabled(db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "provisioning_enabled", False)
    calls = []

    async def _fake(*args):
        calls.append(args)

    monkeypatch.setattr(provisioning_service, "_publish_provision_request", _fake)
    uow, org = await _make_org()
    await provisioning_service.trigger_provisioning(uow, org)

    assert org.deployments == {}  # stays shared
    assert calls == []


@pytest.mark.asyncio
async def test_marks_provisioning_and_publishes_once(db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "provisioning_enabled", True)
    monkeypatch.setattr(get_settings(), "gcp_project_id", "proj")
    monkeypatch.setattr(get_settings(), "provisioning_topic", "tenant-provision-requests")
    calls = []

    async def _fake(project_id, topic, message):
        calls.append((project_id, topic, message))

    monkeypatch.setattr(provisioning_service, "_publish_provision_request", _fake)
    uow, org = await _make_org()
    await provisioning_service.trigger_provisioning(uow, org)

    assert org.deployments["status"] == "provisioning"
    assert org.deployments["slug"] == org.deployment_slug
    assert len(calls) == 1
    project_id, topic, message = calls[0]
    assert project_id == "proj"
    assert topic == "tenant-provision-requests"
    assert message == {"org_id": str(org.id), "slug": org.deployment_slug, "action": "provision"}

    # Idempotent: a second trigger while already provisioning does not re-publish.
    await provisioning_service.trigger_provisioning(uow, org)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_teardown_noop_when_disabled(db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "provisioning_enabled", False)
    calls = []

    async def _fake(*args):
        calls.append(args)

    monkeypatch.setattr(provisioning_service, "_publish_provision_request", _fake)
    org = Organization(name="Acme", slug="s1", deployments={"status": "provisioned"})
    await provisioning_service.trigger_teardown(org)
    assert calls == []


@pytest.mark.asyncio
async def test_teardown_skips_shared_org(db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "provisioning_enabled", True)
    calls = []

    async def _fake(*args):
        calls.append(args)

    monkeypatch.setattr(provisioning_service, "_publish_provision_request", _fake)
    # An org that only ran on the shared stack has nothing dedicated to tear down.
    org = Organization(name="Acme", slug="s1", deployments={})
    await provisioning_service.trigger_teardown(org)
    assert calls == []


@pytest.mark.asyncio
async def test_teardown_publishes_for_provisioned_org(db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "provisioning_enabled", True)
    monkeypatch.setattr(get_settings(), "gcp_project_id", "proj")
    calls = []

    async def _fake(project_id, topic, message):
        calls.append(message)

    monkeypatch.setattr(provisioning_service, "_publish_provision_request", _fake)
    org = Organization(name="Acme", slug="s1", deployments={"status": "provisioned"})
    await provisioning_service.trigger_teardown(org)
    assert len(calls) == 1
    assert calls[0] == {"org_id": str(org.id), "slug": org.deployment_slug, "action": "teardown"}
