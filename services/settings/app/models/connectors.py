"""Non-secret organization connector configuration.

Credentials live in the encrypted org vault. This document contains only the
small pieces of routing metadata an egress sidecar needs alongside those
credentials. It shares the org settings collection but uses its own document so
connector edits cannot clobber policy data.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import utcnow

CONNECTORS_DOC_ID = "connectors"


@dataclass
class OrgConnectorConfig:
    scope_id: str
    jira_origin: str = ""
    jira_email: str = ""
    asana_workspace_id: str = ""
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_doc(self) -> dict:
        return {
            "scope_type": "org",
            "scope_id": self.scope_id,
            "jira_origin": self.jira_origin,
            "jira_email": self.jira_email,
            "asana_workspace_id": self.asana_workspace_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "OrgConnectorConfig":
        return cls(
            scope_id=str(doc.get("scope_id", "")),
            jira_origin=str(doc.get("jira_origin", "") or ""),
            jira_email=str(doc.get("jira_email", "") or ""),
            asana_workspace_id=str(doc.get("asana_workspace_id", "") or ""),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )

    @classmethod
    def empty(cls, scope_id: str) -> "OrgConnectorConfig":
        return cls(scope_id=scope_id)
