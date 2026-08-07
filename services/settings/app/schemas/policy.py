"""Settings-policy request/response schemas (field allowlists + bounds).

Every list and pattern is bounded so a policy document cannot grow unboundedly
or carry control characters (api-security / injection checklists). Domain keys
are restricted to the four known domains — unknown keys are rejected.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.policy import DOMAINS

MAX_ITEMS_PER_LIST = 200
MAX_PATTERN_LENGTH = 200
# Item ids and glob patterns: letters, digits and a small set of id/glob chars.
_PATTERN_RE = re.compile(r"^[A-Za-z0-9_.:/*?\[\]!^-]+$")


def _validate_patterns(values: list[str]) -> list[str]:
    if len(values) > MAX_ITEMS_PER_LIST:
        raise ValueError(f"at most {MAX_ITEMS_PER_LIST} entries allowed")
    cleaned: list[str] = []
    for value in values:
        item = str(value).strip()
        if not item:
            continue
        if len(item) > MAX_PATTERN_LENGTH:
            raise ValueError("pattern is too long")
        if not _PATTERN_RE.match(item):
            raise ValueError(f"invalid pattern: {item!r}")
        cleaned.append(item)
    return cleaned


class DomainPolicySchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    include: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)

    @field_validator("include", "exclude")
    @classmethod
    def _check(cls, values: list[str]) -> list[str]:
        return _validate_patterns(values)


def _validate_domains(domains: dict[str, DomainPolicySchema]) -> dict[str, DomainPolicySchema]:
    unknown = set(domains) - set(DOMAINS)
    if unknown:
        raise ValueError(f"unknown domain(s): {', '.join(sorted(unknown))}")
    return domains


class PolicyUpdate(BaseModel):
    """PUT body — replaces the scope's policy. Any subset of the four domains may
    be provided; omitted domains become empty (no restriction)."""

    domains: dict[str, DomainPolicySchema] = Field(default_factory=dict)

    @field_validator("domains")
    @classmethod
    def _known_domains(cls, domains: dict[str, DomainPolicySchema]) -> dict[str, DomainPolicySchema]:
        return _validate_domains(domains)


class PolicyResponse(BaseModel):
    scope_type: str
    scope_id: str
    domains: dict[str, DomainPolicySchema]
    updated_at: datetime | None = None


class EffectiveDomainSchema(BaseModel):
    """Allowed set at each scope for one domain; ``effective`` is the
    fully-cascaded (user-level) grant."""

    org: list[str]
    project: list[str]
    user: list[str]
    effective: list[str]


class EffectiveResponse(BaseModel):
    project_id: uuid.UUID | None = None
    domains: dict[str, EffectiveDomainSchema]
    universe: dict[str, list[str]]


class UniverseResponse(BaseModel):
    domains: dict[str, list[str]]
