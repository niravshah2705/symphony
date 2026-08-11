"""Injectable organization-invitation notification publisher."""
from __future__ import annotations

import asyncio
import json

from app.core.config import get_settings


async def publish_invitation(payload: dict) -> bool:
    """Publish to EMAIL_TOPIC and report whether the job was actually queued.

    This function is the injection boundary tests/local adapters can monkeypatch.
    Callers must persist and commit the invitation before invoking it.
    """
    settings = get_settings()
    if not settings.email_topic:
        return False

    def _publish() -> None:
        from google.cloud import pubsub_v1

        publisher = pubsub_v1.PublisherClient()
        topic_path = publisher.topic_path(settings.gcp_project_id, settings.email_topic)
        publisher.publish(topic_path, json.dumps(payload).encode("utf-8")).result()

    await asyncio.to_thread(_publish)
    return True
