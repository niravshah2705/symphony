"""Settings-policy request/response schemas (field allowlists + bounds).

Every list and pattern is bounded so a policy document cannot grow unboundedly
or carry control characters (api-security / injection checklists). Domain keys
are restricted to the known domains (models.policy.DOMAINS) — unknown keys are rejected.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.policy import CONFIG_VALUE_KEYS, DOMAINS

MAX_ITEMS_PER_LIST = 200
MAX_PATTERN_LENGTH = 200
# Item ids and glob patterns: letters, digits and a small set of id/glob chars.
_PATTERN_RE = re.compile(r"^[A-Za-z0-9_.:/*?\[\]!^-]+$")

# Config values (provider API keys) are opaque secrets, so they are NOT matched
# against the id/glob pattern set — only bounded and stripped of control chars
# (data-exposure / injection: no CR/LF for log forging, no NUL).
MAX_CONFIG_VALUE_LENGTH = 8192
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


def _validate_config_values(values: dict[str, str]) -> dict[str, str]:
    unknown = set(values) - set(CONFIG_VALUE_KEYS)
    if unknown:
        raise ValueError(f"unknown config value key(s): {', '.join(sorted(unknown))}")
    cleaned: dict[str, str] = {}
    for key, raw in values.items():
        text = str(raw).strip()
        if len(text) > MAX_CONFIG_VALUE_LENGTH:
            raise ValueError(f"config value {key!r} is too long")
        if _CONTROL_CHARS_RE.search(text):
            raise ValueError(f"config value {key!r} contains control characters")
        # Empty string is a meaningful CLEAR; keep it so callers can unset a key.
        cleaned[key] = text
    return cleaned


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


class MaskedConfigValue(BaseModel):
    """Browser-facing view of a config value — presence only, never the secret.
    (data-exposure: even a masked suffix narrows a brute-force search, so we
    expose a boolean, not a partial string.)"""

    set: bool


class PolicyUpdate(BaseModel):
    """PUT body — updates a scope's policy. ``domains`` and ``values`` update
    independently so the write-only secret and the include/exclude lists never
    clobber each other:

    - ``domains``: when PROVIDED (even ``{}``) it REPLACES the scope's domains —
      any subset of the known domains may be given and omitted domains become empty. When
      the whole field is absent (``None``) the stored domains are left untouched.
    - ``values``: MERGE semantics (the browser can never read the stored secret
      back to resend it). ``None``/omitted leaves every stored value untouched; a
      provided key with a non-empty string SETS it; an empty string CLEARS it.
    """

    domains: dict[str, DomainPolicySchema] | None = None
    values: dict[str, str] | None = None

    @field_validator("domains")
    @classmethod
    def _known_domains(
        cls, domains: dict[str, DomainPolicySchema] | None
    ) -> dict[str, DomainPolicySchema] | None:
        if domains is None:
            return None
        return _validate_domains(domains)

    @field_validator("values")
    @classmethod
    def _known_values(cls, values: dict[str, str] | None) -> dict[str, str] | None:
        if values is None:
            return None
        return _validate_config_values(values)


class PolicyResponse(BaseModel):
    scope_type: str
    scope_id: str
    domains: dict[str, DomainPolicySchema]
    # Masked config values for every allow-listed key ({set: bool}); never plaintext.
    values: dict[str, MaskedConfigValue] = Field(default_factory=dict)
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
    # Masked effective config values ({set: bool}) — browser-facing, never plaintext.
    values: dict[str, MaskedConfigValue] = Field(default_factory=dict)


class InternalEffectiveConfigResponse(BaseModel):
    """UNMASKED effective config values. Returned ONLY by the internal S2S
    endpoint (never browser-reachable) so the gateway/planner can wire the
    resolved provider key into the harness."""

    project_id: uuid.UUID | None = None
    values: dict[str, str] = Field(default_factory=dict)


class UniverseResponse(BaseModel):
    domains: dict[str, list[str]]
