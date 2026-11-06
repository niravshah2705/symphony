"""Environment-initialization run (org-scoped).

Firestore: `organizations/{org_id}/environment_runs/{id}`.

The document id is derived from the org plus its *desired revision* — a content
hash of everything the environment is supposed to have — instead of a random
uuid. That one choice is what makes this job re-runnable and a login stampede
harmless: N logins in the same second compute the same id, `db.create` resolves
exactly one of them, and a retry re-executes steps inside the document that
already exists rather than opening a second run. A revision that has already
completed is therefore never published twice, with no TTL to guess at.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import to_uuid, utcnow, uuid_str
from app.models.enums import EnvironmentRunStatus, EnvironmentStepStatus, EnvironmentTrigger

# uuid5 namespace for run ids. Fixed, so an id is reproducible across processes
# and a re-run finds the same document.
RUN_NAMESPACE = uuid.UUID("00000000-0000-0000-0000-0000656e7672")


def run_id_for(org_id: uuid.UUID, desired_revision: str) -> uuid.UUID:
    return uuid.uuid5(RUN_NAMESPACE, f"{org_id}:{desired_revision}")


def step(key: str) -> dict:
    """A fresh step record. Statuses are values, not objects: a step is a
    progress line for a human, and the retry endpoint keys off `key`."""
    return {"key": key, "status": EnvironmentStepStatus.PENDING.value, "detail": None, "updated_at": utcnow()}


@dataclass
class EnvironmentRun:
    org_id: uuid.UUID
    desired_revision: str = ""
    steps: list[dict] = field(default_factory=list)
    trigger: EnvironmentTrigger = EnvironmentTrigger.LOGIN
    status: EnvironmentRunStatus = EnvironmentRunStatus.PENDING
    # Recorded when an executor claims the run. It equals desired_revision unless
    # the org's desired state moved on while this document was waiting, which is
    # how a stale run reports itself instead of looking like it is still working.
    attempted_revision: str | None = None
    # The signed-in user who opened the run. `org.seed` creates the org's default
    # project, which needs a member to own it, and an executor running after the
    # request is gone cannot guess one.
    requested_by: uuid.UUID | None = None
    id: uuid.UUID = None  # type: ignore[assignment]
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def __post_init__(self) -> None:
        if self.id is None:
            self.id = run_id_for(self.org_id, self.desired_revision)

    def step(self, key: str) -> dict | None:
        return next((s for s in self.steps if s.get("key") == key), None)

    def to_doc(self) -> dict:
        return {
            "id": uuid_str(self.id),
            "org_id": uuid_str(self.org_id),
            "desired_revision": self.desired_revision,
            "attempted_revision": self.attempted_revision,
            "requested_by": uuid_str(self.requested_by),
            "trigger": self.trigger.value,
            "status": self.status.value,
            "steps": list(self.steps),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "EnvironmentRun":
        return cls(
            id=uuid.UUID(str(doc["id"])),
            org_id=uuid.UUID(str(doc["org_id"])),
            desired_revision=doc.get("desired_revision", ""),
            attempted_revision=doc.get("attempted_revision"),
            requested_by=to_uuid(doc.get("requested_by")),
            trigger=EnvironmentTrigger(doc.get("trigger", EnvironmentTrigger.LOGIN.value)),
            status=EnvironmentRunStatus(doc.get("status", EnvironmentRunStatus.PENDING.value)),
            steps=list(doc.get("steps") or []),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )
