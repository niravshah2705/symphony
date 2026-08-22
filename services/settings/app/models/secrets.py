"""Organization/project encrypted secret vault — one document per scope.

Third-party provider credentials (GitHub/Linear/LLM keys, and future custom
tokens) are stored at the ORG scope, ENCRYPTED at rest via KMS envelope
encryption (``app.crypto``). The vault is key-agnostic: any key in the
``SECRET_KEYS`` allowlist is stored the same way, so a new token type needs no
new code — just an allowlist entry.

Two things live in each vault document (organization default or project
override):

- ``secrets``: ``{secret_key: EncryptedSecret}`` — the encrypted customer-supplied
  key material. The plaintext is NEVER stored and NEVER returned to a browser
  (responses mask it to ``{set, source}``); plaintext leaves this service only
  over the IAM+token-gated internal S2S endpoint.
- ``selection``: ``{secret_key: "managed" | "customer"}`` — per-key choice of
  whether to use the PLATFORM-managed key (resolved by this service from its
  Secret Manager mount) or the CUSTOMER-supplied key from ``secrets``. Absent =>
  ``managed`` for keys that have a platform credential. Customer-only keys
  always resolve to ``customer`` even when an old document says ``managed``.

This "managed vs customer" axis is orthogonal to the hosted-vs-byom split in
packages/shared/src/agent/model-presets.js (which is about who supplies the
MODEL); this is about who owns the KEY.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.crypto.envelope import EncryptedSecret, is_encrypted_doc
from app.models.base import utcnow

# Allow-listed secret keys the vault will store. Deliberately explicit (never
# free-form) so the document can only carry known provider credentials. Superset
# of app.models.policy.CONFIG_VALUE_KEYS. Add new provider keys here; the JS
# mirror is packages/shared/src/agent/settings-policy.js.
SECRET_KEYS: tuple[str, ...] = (
    "geminiApiKey",
    "githubToken",
    "linearApiKey",
    "gitlabToken",
    "jiraApiToken",
    "asanaAccessToken",
    "omlxApiKey",
    "slackWebhookUrl",
    "anthropicApiKey",
    "openaiApiKey",
    "huggingfaceApiKey",
    "langsmithApiKey",
    "digilockerClientId",
    "digilockerClientSecret",
    # JSON-encoded OpenAI/Codex OAuth token bundle. Provisioned only through the
    # direct org-admin operator surface; never accepted by the browser gateway.
    "codexTokenBundle",
    # LangSmith LLM Gateway WORKSPACE key (distinct from langsmithApiKey, the
    # tracing key). Managed-only: it bills the platform's LangSmith workspace,
    # so it is resolved like any managed key but never writable by a browser.
    "langsmithGatewayApiKey",
)

# Browser-facing org-admin secret CRUD is intentionally narrower than the
# storage/resolver allowlist. OAuth bundles must pass the typed, direct
# operator-only import flow; accepting their opaque JSON through generic secret
# CRUD would bypass token validation and that separate IAM boundary. The LLM
# gateway workspace key is platform-billing material and stays operator-only.
BROWSER_WRITABLE_SECRET_KEYS: tuple[str, ...] = tuple(
    key for key in SECRET_KEYS if key not in ("codexTokenBundle", "langsmithGatewayApiKey")
)

# Who owns each provider's key. "managed" => platform key (settings-mounted);
# "customer" => the org's own key from `secrets`.
SELECTION_MODES: tuple[str, ...] = ("managed", "customer")
DEFAULT_SELECTION = "managed"

# These integrations have no platform-owned credential. Keeping this policy in
# the vault model (rather than only in the browser) ensures stale documents,
# direct API callers, readiness, and the internal resolver all fail closed in
# exactly the same way.
CUSTOMER_ONLY_SECRET_KEYS: frozenset[str] = frozenset(
    {
        "linearApiKey",
        "gitlabToken",
        "jiraApiToken",
        "asanaAccessToken",
        "omlxApiKey",
        "slackWebhookUrl",
        "digilockerClientId",
        "digilockerClientSecret",
    }
)

# Firestore document id for the single vault doc within an org's `secrets` col.
SECRETS_DOC_ID = "vault"


def clean_selection(raw: dict | None) -> dict[str, str]:
    """Keep only allow-listed keys with a known selection mode (defensive: a
    stored doc could carry stale/unknown keys or modes)."""
    out: dict[str, str] = {}
    for key in SECRET_KEYS:
        mode = (raw or {}).get(key)
        if key in CUSTOMER_ONLY_SECRET_KEYS:
            # Customer is the only possible source, so no selection record is
            # needed. Omitting it also lets a cleared project value inherit the
            # org value instead of becoming a permanent missing override.
            continue
        elif mode in SELECTION_MODES:
            out[key] = mode
    return out


def allowed_sources_for(key: str) -> tuple[str, ...]:
    """Source modes the credential supports, in stable display order."""
    if key in CUSTOMER_ONLY_SECRET_KEYS:
        return ("customer",)
    return SELECTION_MODES


def default_selection_for(key: str) -> str:
    return "customer" if key in CUSTOMER_ONLY_SECRET_KEYS else DEFAULT_SELECTION


def _clean_secrets(raw: dict | None) -> dict[str, EncryptedSecret]:
    """Parse only well-formed encrypted records for allow-listed keys."""
    out: dict[str, EncryptedSecret] = {}
    for key in SECRET_KEYS:
        doc = (raw or {}).get(key)
        if is_encrypted_doc(doc):
            out[key] = EncryptedSecret.from_doc(doc)
    return out


@dataclass
class OrgSecrets:
    scope_id: str
    scope_type: str = "org"
    secrets: dict[str, EncryptedSecret] = field(default_factory=dict)
    selection: dict[str, str] = field(default_factory=dict)
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def selection_for(self, key: str) -> str:
        """Effective selection, enforcing customer-only capabilities."""
        if key in CUSTOMER_ONLY_SECRET_KEYS:
            return "customer"
        return self.selection.get(key, default_selection_for(key))

    def to_doc(self) -> dict:
        return {
            "scope_type": self.scope_type,
            "scope_id": self.scope_id,
            "secrets": {key: rec.to_doc() for key, rec in self.secrets.items()},
            "selection": clean_selection(self.selection),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_doc(cls, doc: dict) -> "OrgSecrets":
        return cls(
            scope_id=doc.get("scope_id", ""),
            scope_type=doc.get("scope_type", "org"),
            secrets=_clean_secrets(doc.get("secrets")),
            selection=clean_selection(doc.get("selection")),
            created_at=doc.get("created_at") or utcnow(),
            updated_at=doc.get("updated_at") or utcnow(),
        )

    @classmethod
    def empty(cls, scope_id: str, scope_type: str = "org") -> "OrgSecrets":
        return cls(
            scope_id=scope_id,
            scope_type=scope_type,
            secrets={},
            selection={},
        )
