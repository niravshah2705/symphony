"""Per-org encrypted vault business logic.

Scope always derives from the authenticated Principal (``principal.org_id``) for
the browser-facing routes — never a path/body org id. The internal S2S resolve
takes an ``org_id`` path param because it carries no user identity: the
X-Internal-Token IS the authorization and the read is confined to that one org's
vault (mirrors the org service's write-back endpoint).

Secrets are write-only over the browser surface (masked to ``{set, source}``);
plaintext is produced only by ``resolve_secrets_for_org`` for the internal S2S
endpoint. Encryption/decryption goes through the single ``app.crypto`` vault.
"""
from __future__ import annotations

import os
import uuid

from app.authz.principal import Principal
from app.core.database import Uow
from app.core.timeutils import utcnow
from app.crypto.vault import get_vault
from app.models.secrets import SECRET_KEYS, OrgSecrets, clean_selection
from app.repositories.base import org_secrets_col
from app.repositories.secrets_repo import SecretsRepository
from app.schemas.secrets import (
    InternalOrgSecretsResponse,
    MaskedSecret,
    ResolvedSecret,
    SecretsResponse,
    SecretsUpdate,
    SelectionUpdate,
)


# Platform-managed provider keys the settings service reads from its OWN env
# (mounted from Secret Manager on settings-sa). This is the SINGLE managed-key
# source: the resolver returns these for a `managed` selection, so the proxy uses
# ONE path for both managed and customer keys (the store.js SECRET_ENV overlay is
# no longer a separate managed path for the proxied services). Mirrors the JS
# names in packages/shared/src/store.js SECRET_ENV.
MANAGED_ENV = {
    "geminiApiKey": "GEMINI_API_KEY",
    "githubToken": "GITHUB_TOKEN",
    "linearApiKey": "LINEAR_API_KEY",
    "anthropicApiKey": "ANTHROPIC_API_KEY",
    "openaiApiKey": "OPENAI_API_KEY",
    "huggingfaceApiKey": "HUGGINGFACE_API_KEY",
    "langsmithApiKey": "LANGSMITH_API_KEY",
}


def _managed_value(key: str) -> str | None:
    """The platform-managed value for a key, from the settings service env."""
    env_name = MANAGED_ENV.get(key)
    value = os.environ.get(env_name, "") if env_name else ""
    return value or None


def _mask(secrets: OrgSecrets) -> dict[str, MaskedSecret]:
    """Presence + ownership for every allow-listed key — never the secret."""
    return {
        key: MaskedSecret(set=key in secrets.secrets, source=secrets.selection_for(key))
        for key in SECRET_KEYS
    }


def _to_response(secrets: OrgSecrets) -> SecretsResponse:
    return SecretsResponse(
        scope_id=secrets.scope_id,
        secrets=_mask(secrets),
        updated_at=secrets.updated_at,
    )


async def get_org_secrets(session: Uow, principal: Principal) -> SecretsResponse:
    org_id = principal.org_id
    secrets = await SecretsRepository(session).get(org_secrets_col(org_id))
    return _to_response(secrets or OrgSecrets.empty(str(org_id)))


async def set_org_secrets(
    session: Uow, principal: Principal, body: SecretsUpdate
) -> SecretsResponse:
    """Encrypt-on-write with merge semantics: a non-empty value sets (encrypts)
    a key; an empty string clears it; omitted keys are preserved."""
    org_id = principal.org_id
    col = org_secrets_col(org_id)
    repo = SecretsRepository(session)
    current = await repo.get(col) or OrgSecrets.empty(str(org_id))

    new_secrets = dict(current.secrets)
    if body.values is not None:
        to_encrypt: dict[str, str] = {}
        for key, value in body.values.items():
            if value:
                to_encrypt[key] = value
            else:
                new_secrets.pop(key, None)
        if to_encrypt:
            new_secrets.update(get_vault().encrypt_map(to_encrypt))

    updated = OrgSecrets(
        scope_id=str(org_id),
        secrets=new_secrets,
        selection=dict(current.selection),
        created_at=current.created_at,
        updated_at=utcnow(),
    )
    await repo.upsert(col, updated)
    return _to_response(updated)


async def set_selection(
    session: Uow, principal: Principal, body: SelectionUpdate
) -> SecretsResponse:
    """Merge the per-key managed/customer selection; only provided keys change."""
    org_id = principal.org_id
    col = org_secrets_col(org_id)
    repo = SecretsRepository(session)
    current = await repo.get(col) or OrgSecrets.empty(str(org_id))

    merged = dict(current.selection)
    merged.update(body.selection)
    updated = OrgSecrets(
        scope_id=str(org_id),
        secrets=dict(current.secrets),
        selection=clean_selection(merged),
        created_at=current.created_at,
        updated_at=utcnow(),
    )
    await repo.upsert(col, updated)
    return _to_response(updated)


async def resolve_secrets_for_org(
    session: Uow, org_id: uuid.UUID
) -> InternalOrgSecretsResponse:
    """INTERNAL S2S ONLY. Resolve every allow-listed key for the egress proxy:

    - ``managed``  => ``{source: managed}`` (no value; proxy uses its platform key)
    - ``customer`` => decrypted plaintext, or ``{value: None, error: "missing"}``
      when the org chose customer but stored no key (proxy fails closed).

    A ``DecryptError`` propagates (→ 500) so a decryption failure never
    degrades into a wrong/empty credential.
    """
    secrets = await SecretsRepository(session).get(org_secrets_col(org_id)) or OrgSecrets.empty(
        str(org_id)
    )

    customer_records = {
        key: rec
        for key, rec in secrets.secrets.items()
        if secrets.selection_for(key) == "customer"
    }
    decrypted = get_vault().decrypt_map(customer_records) if customer_records else {}

    resolved: dict[str, ResolvedSecret] = {}
    for key in SECRET_KEYS:
        if secrets.selection_for(key) == "customer":
            if key in decrypted:
                resolved[key] = ResolvedSecret(source="customer", value=decrypted[key])
            else:
                resolved[key] = ResolvedSecret(source="customer", value=None, error="missing")
        else:
            # Managed: resolve the platform key here (same resolver, same shape)
            # so the proxy has ONE path and never needs its own env for managed.
            resolved[key] = ResolvedSecret(source="managed", value=_managed_value(key))
    return InternalOrgSecretsResponse(org_id=org_id, secrets=resolved)


async def resolve_managed_secrets() -> InternalOrgSecretsResponse:
    """INTERNAL S2S ONLY. Resolve the platform-managed keys with NO org (the
    shared stack, where there is no per-org vault). Every key is `managed`, valued
    from the settings service env — same response shape as the per-org resolve so
    the proxy uses one code path."""
    resolved = {
        key: ResolvedSecret(source="managed", value=_managed_value(key)) for key in SECRET_KEYS
    }
    return InternalOrgSecretsResponse(org_id=None, secrets=resolved)
