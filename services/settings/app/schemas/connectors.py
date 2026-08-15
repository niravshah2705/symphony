"""Request/response contracts for non-secret org connector metadata."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator

from app.schemas.policy import _CONTROL_CHARS_RE

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_ASANA_WORKSPACE_RE = re.compile(r"^[0-9]{1,64}$")
_JIRA_CLOUD_HOST_RE = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$"
)


def normalize_jira_cloud_origin(value: str) -> str:
    """Accept only an HTTPS Atlassian Cloud origin, never a path/SSRF target."""
    text = str(value or "").strip()
    if not text:
        return ""
    parsed = urlsplit(text)
    hostname = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("jira_origin contains an invalid port") from exc
    if (
        parsed.scheme.lower() != "https"
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or not _JIRA_CLOUD_HOST_RE.fullmatch(hostname)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "jira_origin must be an HTTPS Jira Cloud origin like "
            "https://company.atlassian.net"
        )
    return f"https://{hostname}"


class ConnectorConfigUpdate(BaseModel):
    """Merge update: omitted fields preserve; an empty string clears."""

    jira_origin: str | None = None
    jira_email: str | None = None
    asana_workspace_id: str | None = None

    @field_validator("jira_origin")
    @classmethod
    def _jira_origin(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return normalize_jira_cloud_origin(value)

    @field_validator("jira_email")
    @classmethod
    def _jira_email(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        if len(text) > 320 or _CONTROL_CHARS_RE.search(text):
            raise ValueError("jira_email is invalid")
        if text and not _EMAIL_RE.fullmatch(text):
            raise ValueError("jira_email must be a valid email address")
        return text

    @field_validator("asana_workspace_id")
    @classmethod
    def _asana_workspace_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        if text and not _ASANA_WORKSPACE_RE.fullmatch(text):
            raise ValueError("asana_workspace_id must be a numeric Asana GID")
        return text


class ConnectorConfigResponse(BaseModel):
    jira_origin: str = ""
    jira_email: str = ""
    asana_workspace_id: str = ""


class ConnectorReadiness(BaseModel):
    configured: bool
    routable: bool
    supported: bool
    verified: bool = False


class ConnectorReadinessResponse(BaseModel):
    connectors: dict[str, ConnectorReadiness] = Field(default_factory=dict)
