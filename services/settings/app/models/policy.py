"""Settings policy model — one document per scope.

A policy holds two things per scope:

- Per domain in {harness, tools, skills, plugins}, an ``include`` list and an
  ``exclude`` list of item ids / glob patterns (e.g. ``security:*``) — the
  narrowing cascade (exclude wins downward).
- A ``values`` map of allow-listed CONFIG VALUES (provider API keys, starting
  with ``geminiApiKey``): per-scope overrides resolved with user > project > org
  precedence. Value entries are WRITE-ONLY SECRETS — the plaintext is stored
  here but is NEVER returned to the browser (responses mask it to a
  ``{set: bool}`` marker); the plaintext leaves this service only over the
  IAM-gated internal S2S endpoint.

One policy document lives at each scope:

- org:     ``organizations/{org_id}/settings/policy``
- project: ``organizations/{org_id}/projects/{project_id}/settings/policy``
- user:    ``users/{user_id}/settings/policy``

An absent document is equivalent to an empty policy (no include/exclude on any
domain and no config values), which imposes no restriction at that scope.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.models.base import utcnow

# The settings domains, in stable display order. `hooks` governs lifecycle-hook
# ids (config + catalog only today; no execution engine yet — see the JS mirror
# settings-policy.js filterHooksByPolicy TODO). `models` governs the task-model
# catalog (allow/deny per model id or provider glob) — see universe.MODELS; its
# ENFORCEMENT runs JS-side against the live catalog, so the Python universe mirror
# only feeds the effective-set display.
DOMAINS: tuple[str, ...] = ("harness", "tools", "skills", "plugins", "hooks", "models")

# Allow-listed CONFIG VALUE keys stored per scope. Deliberately small and
# explicit (never free-form) so a policy document can only carry known provider
# credentials. Add new provider key names here as they are supported; the JS
# mirror is packages/shared/src/agent/settings-policy.js CONFIG_VALUE_KEYS.
CONFIG_VALUE_KEYS: tuple[str, ...] = ("geminiApiKey",)

# Firestore document id used for the single policy doc within each scope's
# ``.../settings`` collection.
POLICY_DOC_ID = "policy"


def clean_config_values(raw: dict | None) -> dict[str, str]:
    """Keep only allow-listed keys with non-empty string values (defensive: a
    Firestore doc could carry stale/unknown keys)."""
    values: dict[str, str] = {}
    for key in CONFIG_VALUE_KEYS:
        candidate = (raw or {}).get(key)
        if candidate is None:
            continue
        text = str(candidate)
        if text:
            values[key] = text
    return values


@dataclass
class DomainPolicy:
    """include/exclude for one domain. Empty include means 'the whole universe'
    (before exclusions); exclude always removes."""

    include: list[str] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)

    def to_doc(self) -> dict:
        return {"include": list(self.include), "exclude": list(self.exclude)}

    @classmethod
    def from_doc(cls, doc: dict | None) -> "DomainPolicy":
        doc = doc or {}
        return cls(
            include=[str(x) for x in (doc.get("include") or [])],
            exclude=[str(x) for x in (doc.get("exclude") or [])],
        )


@dataclass
class SettingsPolicy:
    scope_type: str  # "org" | "project" | "user"
    scope_id: str
    domains: dict[str, DomainPolicy] = field(default_factory=dict)
    # Allow-listed config values (secrets). Only keys in CONFIG_VALUE_KEYS.
    values: dict[str, str] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def domain(self, name: str) -> DomainPolicy:
        """Return the domain policy (empty if unset) — never raises."""
        return self.domains.get(name, DomainPolicy())

    def to_doc(self) -> dict:
        return {
            "scope_type": self.scope_type,
            "scope_id": self.scope_id,
            "domains": {name: self.domains[name].to_doc() for name in self.domains},
            "values": clean_config_values(self.values),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "SettingsPolicy":
        raw_domains = doc.get("domains") or {}
        return cls(
            scope_type=doc.get("scope_type", ""),
            scope_id=doc.get("scope_id", ""),
            domains={
                name: DomainPolicy.from_doc(raw_domains.get(name))
                for name in raw_domains
                if name in DOMAINS
            },
            values=clean_config_values(doc.get("values")),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )

    @classmethod
    def empty(cls, scope_type: str, scope_id: str) -> "SettingsPolicy":
        return cls(
            scope_type=scope_type,
            scope_id=scope_id,
            domains={name: DomainPolicy() for name in DOMAINS},
            values={},
        )
