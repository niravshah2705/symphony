"""Per-tenant provisioning trigger (org side).

When an org is EXPLICITLY created (self-service create-org, local register,
super-admin create), and provisioning is enabled, this marks the org
``deployments.status = provisioning`` and publishes a ``tenant-provision``
request. A separate internal provisioner service consumes it, stands up the
dedicated Cloud Run stack (reusing existing images), and writes the resolved
URLs back via ``PATCH /api/v1/internal/orgs/{id}/deployments``.

OFF by default (settings.provisioning_enabled) — a disabled deployment keeps
every org on the shared stack: no status change, no publish, no infra. The auto
pseudo-workspace path (onboarding_service.ensure_org_for_user) never calls this.
"""
from __future__ import annotations

import asyncio
import json

from app.core.config import get_settings
from app.core.database import Uow
from app.core.timeutils import utcnow
from app.models.organization import Organization

# Statuses that mean a provision is already in-flight or done — re-triggering is
# a no-op (idempotent; no duplicate publish).
_INFLIGHT = frozenset({"provisioning", "provisioned"})


async def trigger_provisioning(session: Uow, org: Organization) -> None:
    settings = get_settings()
    if not settings.provisioning_enabled:
        return
    deployments = org.deployments if isinstance(org.deployments, dict) else {}
    if deployments.get("status") in _INFLIGHT:
        return
    # Mark in-flight (a NEW map — no in-place mutation). Flushed on commit since
    # `org` is tracked by the unit of work.
    org.deployments = {
        "status": "provisioning",
        "slug": org.deployment_slug,
        "updated_at": utcnow().isoformat(),
    }
    org.updated_at = utcnow()
    await _publish_provision_request(
        settings.gcp_project_id,
        settings.provisioning_topic,
        {"org_id": str(org.id), "slug": org.deployment_slug, "action": "provision"},
    )


async def _publish_provision_request(project_id: str, topic: str, message: dict) -> None:
    """Publish a provision request to Pub/Sub. Overridable in tests.

    Lazily imports the SDK so the dependency is only needed when provisioning is
    actually enabled. The blocking publish runs off the event loop.
    """
    def _publish() -> None:
        from google.cloud import pubsub_v1  # lazy

        publisher = pubsub_v1.PublisherClient()
        topic_path = publisher.topic_path(project_id, topic)
        publisher.publish(topic_path, json.dumps(message).encode("utf-8")).result()

    await asyncio.to_thread(_publish)
