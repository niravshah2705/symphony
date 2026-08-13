"""Per-org secret vault request/response schemas.

Mirrors the hardening in schemas/policy.py: secret values are opaque, so they
are only bounded and stripped of control characters (no CR/LF log forging, no
NUL) — never matched against an id/glob pattern. Keys are restricted to the
``SECRET_KEYS`` allowlist; selection modes to ``SELECTION_MODES``.

Secrets are WRITE-ONLY over the browser surface: responses expose presence +
ownership (``{set, source}``), never the plaintext.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.models.secrets import BROWSER_WRITABLE_SECRET_KEYS, SECRET_KEYS, SELECTION_MODES
from app.schemas.policy import MAX_CONFIG_VALUE_LENGTH, _CONTROL_CHARS_RE

SelectionMode = Literal["managed", "customer"]


def _validate_secret_values(values: dict[str, str]) -> dict[str, str]:
    unknown = set(values) - set(BROWSER_WRITABLE_SECRET_KEYS)
    if unknown:
        raise ValueError(f"unknown secret key(s): {', '.join(sorted(unknown))}")
    cleaned: dict[str, str] = {}
    for key, raw in values.items():
        text = str(raw).strip()
        if len(text) > MAX_CONFIG_VALUE_LENGTH:
            raise ValueError(f"secret {key!r} is too long")
        if _CONTROL_CHARS_RE.search(text):
            raise ValueError(f"secret {key!r} contains control characters")
        # Empty string is a meaningful CLEAR; keep it so callers can unset a key.
        cleaned[key] = text
    return cleaned


def _validate_selection(selection: dict[str, str]) -> dict[str, str]:
    unknown = set(selection) - set(BROWSER_WRITABLE_SECRET_KEYS)
    if unknown:
        raise ValueError(f"unknown secret key(s): {', '.join(sorted(unknown))}")
    for key, mode in selection.items():
        if mode not in SELECTION_MODES:
            raise ValueError(f"selection for {key!r} must be one of {SELECTION_MODES}")
    return selection


class SecretsUpdate(BaseModel):
    """PUT body — MERGE semantics (the browser can never read a stored secret
    back to resend it): ``None``/omitted leaves every stored value untouched; a
    provided key with a non-empty string SETS (encrypts) it; an empty string
    CLEARS it."""

    values: dict[str, str] | None = None

    @field_validator("values")
    @classmethod
    def _known_values(cls, values: dict[str, str] | None) -> dict[str, str] | None:
        if values is None:
            return None
        return _validate_secret_values(values)


class SelectionUpdate(BaseModel):
    """PUT body — per-key managed/customer choice. MERGE semantics: only the
    provided keys are updated; omitted keys keep their stored selection."""

    selection: dict[str, SelectionMode]

    @field_validator("selection")
    @classmethod
    def _known_selection(cls, selection: dict[str, str]) -> dict[str, str]:
        return _validate_selection(selection)


class MaskedSecret(BaseModel):
    """Browser-facing view of one secret — presence + ownership, never the value.
    (data-exposure: even a masked suffix narrows a brute-force search.)"""

    set: bool
    source: SelectionMode


class SecretsResponse(BaseModel):
    scope_id: str
    # Masked entry for every allow-listed key ({set, source}); never plaintext.
    secrets: dict[str, MaskedSecret] = Field(default_factory=dict)
    updated_at: datetime | None = None


class ResolvedSecret(BaseModel):
    """One resolved credential for the internal S2S caller (the egress proxy).

    - ``managed``  => no value; the proxy uses its own mounted platform key.
    - ``customer`` => ``value`` is the decrypted plaintext, or ``None`` with
      ``error="missing"`` when the org opted into customer but stored no key
      (the proxy must FAIL CLOSED, not fall back to a managed key).
    """

    source: SelectionMode
    value: str | None = None
    error: str | None = None


class InternalOrgSecretsResponse(BaseModel):
    """UNMASKED resolved secrets. Returned ONLY by the internal S2S endpoints
    (never browser-reachable, IAM + organization-bound token gated). ``org_id``
    is null for the shared managed-only resolve, which uses the shared token."""

    org_id: uuid.UUID | None = None
    secrets: dict[str, ResolvedSecret] = Field(default_factory=dict)
