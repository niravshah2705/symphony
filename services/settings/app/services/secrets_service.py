"""Organization/project encrypted vault business logic.

Scope always derives from the authenticated Principal (``principal.org_id``) for
the browser-facing routes — never a path/body org id. The internal S2S resolve
takes an ``org_id`` path param because it carries no user identity. Its
``X-Org-Internal-Token`` is derived for that exact organization; a tenant proxy
cannot use its bearer to select another vault.

Secrets are write-only over the browser surface (masked to ``{set, source}``);
plaintext is produced only by ``resolve_secrets_for_org`` for the internal S2S
endpoint. Encryption/decryption goes through the single ``app.crypto`` vault.
"""
from __future__ import annotations

import json
import os
import uuid

from app.authz.guards import ProjectContext
from app.authz.principal import Principal
from app.core.database import Uow
from app.core.timeutils import utcnow
from app.crypto.vault import get_vault
from app.models.secrets import (
    CUSTOMER_ONLY_SECRET_KEYS,
    SECRET_KEYS,
    SECRETS_DOC_ID,
    OrgSecrets,
    allowed_sources_for,
    clean_selection,
)
from app.repositories.base import org_secrets_col, project_secrets_col
from app.repositories.secrets_repo import SecretsRepository
from app.schemas.secrets import (
    InternalOrgSecretsResponse,
    MaskedSecret,
    ResolvedSecret,
    SecretsResponse,
    SecretsUpdate,
    SelectionUpdate,
)
from app.schemas.codex_tokens import (
    CodexTokenBundle,
    CodexTokenImportRequest,
    CodexTokenRotateRequest,
    CodexTokenRotateResponse,
    CodexTokenStatus,
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
    "anthropicApiKey": "ANTHROPIC_API_KEY",
    "openaiApiKey": "OPENAI_API_KEY",
    "huggingfaceApiKey": "HUGGINGFACE_API_KEY",
    "langsmithApiKey": "LANGSMITH_API_KEY",
    # OAuth bundles have no environment fallback. Platform operators may still
    # import a managed bundle through the same encrypted vault if desired.
    "codexTokenBundle": "",
}


def _managed_value(key: str) -> str | None:
    """The platform-managed value for a key, from the settings service env."""
    env_name = MANAGED_ENV.get(key)
    value = os.environ.get(env_name, "") if env_name else ""
    return value or None


async def credential_readiness_for_org(
    session: Uow,
    org_id: uuid.UUID | None,
    project_id: uuid.UUID | None = None,
) -> dict[str, dict[str, str | bool | None]]:
    """Return presence/source only for preflight; never decrypt customer values."""
    if org_id is None:
        return {
            key: {
                "ready": False if key in CUSTOMER_ONLY_SECRET_KEYS else bool(_managed_value(key)),
                "source": "customer" if key in CUSTOMER_ONLY_SECRET_KEYS else "managed",
            }
            for key in SECRET_KEYS
        }
    org_vault, project_vault = await _load_resolution_vaults(
        session, org_id, project_id
    )
    readiness: dict[str, dict[str, str | bool | None]] = {}
    for key in SECRET_KEYS:
        stored = _vault_for_key(org_vault, project_vault, key)
        source = stored.selection_for(key)
        ready = (
            key in stored.secrets
            if source == "customer"
            else bool(_managed_value(key))
        )
        readiness[key] = {"ready": ready, "source": source}
    return readiness


def _mask(secrets: OrgSecrets) -> dict[str, MaskedSecret]:
    """Presence + ownership for every allow-listed key — never the secret."""
    return {
        key: MaskedSecret(
            set=key in secrets.secrets,
            source=secrets.selection_for(key),
            allowed_sources=list(allowed_sources_for(key)),
        )
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


async def get_project_secrets(
    session: Uow, ctx: ProjectContext
) -> SecretsResponse:
    secrets = await SecretsRepository(session).get(
        project_secrets_col(ctx.org_id, ctx.project_id)
    )
    return _to_response(
        secrets or OrgSecrets.empty(str(ctx.project_id), scope_type="project")
    )


async def _set_scope_secrets(
    session: Uow,
    *,
    col: str,
    scope_id: str,
    scope_type: str,
    body: SecretsUpdate,
) -> SecretsResponse:
    """Transactional merge shared by org and project vaults."""
    encrypted: dict = {}
    if body.values is not None:
        to_encrypt = {key: value for key, value in body.values.items() if value}
        if to_encrypt:
            encrypted = get_vault().encrypt_map(to_encrypt)

    async def update(txn):
        doc = await txn.get(col, SECRETS_DOC_ID)
        current = (
            OrgSecrets.from_doc(doc)
            if doc
            else OrgSecrets.empty(scope_id, scope_type=scope_type)
        )
        new_secrets = dict(current.secrets)
        selection = dict(current.selection)
        for key, value in (body.values or {}).items():
            if value:
                new_secrets[key] = encrypted[key]
            else:
                new_secrets.pop(key, None)
                # Customer-only project entries have no meaningful source
                # choice. Clearing their value must clear the project override
                # as well, so resolution inherits the organization credential.
                # Organization clears intentionally remain selected-customer +
                # missing (fail closed), and an explicit selection in this same
                # atomic request is applied immediately below.
                if scope_type == "project" and key in CUSTOMER_ONLY_SECRET_KEYS:
                    selection.pop(key, None)
        if body.selection is not None:
            selection.update(body.selection)
        updated = OrgSecrets(
            scope_id=scope_id,
            scope_type=scope_type,
            secrets=new_secrets,
            selection=clean_selection(selection),
            created_at=current.created_at,
            updated_at=utcnow(),
        )
        txn.set(col, SECRETS_DOC_ID, updated.to_doc())
        return updated

    return _to_response(await session.db.run_transaction(update))


async def set_org_secrets(
    session: Uow, principal: Principal, body: SecretsUpdate
) -> SecretsResponse:
    """Encrypt-on-write with merge semantics: a non-empty value sets (encrypts)
    a key; an empty string clears it; omitted keys are preserved."""
    org_id = principal.org_id
    return await _set_scope_secrets(
        session,
        col=org_secrets_col(org_id),
        scope_id=str(org_id),
        scope_type="org",
        body=body,
    )


async def set_project_secrets(
    session: Uow, ctx: ProjectContext, body: SecretsUpdate
) -> SecretsResponse:
    return await _set_scope_secrets(
        session,
        col=project_secrets_col(ctx.org_id, ctx.project_id),
        scope_id=str(ctx.project_id),
        scope_type="project",
        body=body,
    )


async def _set_scope_selection(
    session: Uow,
    *,
    col: str,
    scope_id: str,
    scope_type: str,
    body: SelectionUpdate,
) -> SecretsResponse:
    async def update(txn):
        doc = await txn.get(col, SECRETS_DOC_ID)
        current = (
            OrgSecrets.from_doc(doc)
            if doc
            else OrgSecrets.empty(scope_id, scope_type=scope_type)
        )
        merged = dict(current.selection)
        merged.update(body.selection)
        updated = OrgSecrets(
            scope_id=scope_id,
            scope_type=scope_type,
            secrets=dict(current.secrets),
            selection=clean_selection(merged),
            created_at=current.created_at,
            updated_at=utcnow(),
        )
        txn.set(col, SECRETS_DOC_ID, updated.to_doc())
        return updated

    return _to_response(await session.db.run_transaction(update))


async def set_selection(
    session: Uow, principal: Principal, body: SelectionUpdate
) -> SecretsResponse:
    """Merge the per-key managed/customer selection; only provided keys change."""
    org_id = principal.org_id
    return await _set_scope_selection(
        session,
        col=org_secrets_col(org_id),
        scope_id=str(org_id),
        scope_type="org",
        body=body,
    )


async def set_project_selection(
    session: Uow, ctx: ProjectContext, body: SelectionUpdate
) -> SecretsResponse:
    return await _set_scope_selection(
        session,
        col=project_secrets_col(ctx.org_id, ctx.project_id),
        scope_id=str(ctx.project_id),
        scope_type="project",
        body=body,
    )


async def _load_resolution_vaults(
    session: Uow,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
) -> tuple[OrgSecrets, OrgSecrets | None]:
    repo = SecretsRepository(session)
    org_vault = await repo.get(org_secrets_col(org_id)) or OrgSecrets.empty(
        str(org_id)
    )
    project_vault = None
    if project_id is not None:
        project_vault = await repo.get(project_secrets_col(org_id, project_id))
    return org_vault, project_vault


def _vault_for_key(
    org_vault: OrgSecrets,
    project_vault: OrgSecrets | None,
    key: str,
) -> OrgSecrets:
    """Use a project override only when it explicitly carries value/source."""
    if project_vault is not None and (
        key in project_vault.secrets or key in project_vault.selection
    ):
        return project_vault
    return org_vault


async def resolve_secrets_for_org(
    session: Uow,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None = None,
) -> InternalOrgSecretsResponse:
    """INTERNAL S2S ONLY. Resolve every allow-listed key for the egress proxy:

    - ``managed``  => plaintext resolved from this service's managed environment
    - ``customer`` => decrypted plaintext, or ``{value: None, error: "missing"}``
      when the org chose customer but stored no key (proxy fails closed).

    A ``DecryptError`` propagates (→ 500) so a decryption failure never
    degrades into a wrong/empty credential.
    """
    org_vault, project_vault = await _load_resolution_vaults(
        session, org_id, project_id
    )
    selected = {
        key: _vault_for_key(org_vault, project_vault, key) for key in SECRET_KEYS
    }
    customer_records = {
        key: stored.secrets[key]
        for key, stored in selected.items()
        if stored.selection_for(key) == "customer" and key in stored.secrets
    }
    decrypted = get_vault().decrypt_map(customer_records) if customer_records else {}

    resolved: dict[str, ResolvedSecret] = {}
    for key in SECRET_KEYS:
        secrets = selected[key]
        if secrets.selection_for(key) == "customer":
            if key in decrypted:
                resolved[key] = ResolvedSecret(source="customer", value=decrypted[key])
            else:
                resolved[key] = ResolvedSecret(source="customer", value=None, error="missing")
        else:
            # Managed: resolve the platform key here (same resolver, same shape)
            # so the proxy has ONE path and never needs its own env for managed.
            resolved[key] = ResolvedSecret(source="managed", value=_managed_value(key))
    return InternalOrgSecretsResponse(
        org_id=org_id, project_id=project_id, secrets=resolved
    )


async def resolve_managed_secrets() -> InternalOrgSecretsResponse:
    """INTERNAL S2S ONLY. Resolve the platform-managed keys with NO org (the
    shared stack, where there is no per-org vault). Every key is `managed`, valued
    from the settings service env — same response shape as the per-org resolve so
    the proxy uses one code path."""
    resolved = {}
    for key in SECRET_KEYS:
        if key in CUSTOMER_ONLY_SECRET_KEYS:
            resolved[key] = ResolvedSecret(
                source="customer", value=None, error="missing"
            )
        else:
            resolved[key] = ResolvedSecret(
                source="managed", value=_managed_value(key)
            )
    return InternalOrgSecretsResponse(org_id=None, secrets=resolved)


def _bundle_json(bundle: CodexTokenBundle) -> str:
    return json.dumps(
        bundle.model_dump(by_alias=True), sort_keys=True, separators=(",", ":")
    )


def _parse_bundle(value: str) -> CodexTokenBundle:
    return CodexTokenBundle.model_validate(json.loads(value))


async def import_codex_tokens(
    session: Uow, principal: Principal, body: CodexTokenImportRequest
) -> CodexTokenStatus:
    """Encrypt an operator-supplied bundle and select it for this organization."""
    org_id = principal.org_id
    col = org_secrets_col(org_id)
    encrypted = get_vault().encrypt_map(
        {"codexTokenBundle": _bundle_json(body.tokens)}
    )["codexTokenBundle"]

    async def update(txn):
        doc = await txn.get(col, SECRETS_DOC_ID)
        current = OrgSecrets.from_doc(doc) if doc else OrgSecrets.empty(str(org_id))
        updated = OrgSecrets(
            scope_id=str(org_id),
            secrets={**current.secrets, "codexTokenBundle": encrypted},
            selection={**current.selection, "codexTokenBundle": "customer"},
            created_at=current.created_at,
            updated_at=utcnow(),
        )
        txn.set(col, SECRETS_DOC_ID, updated.to_doc())
        return updated

    updated = await session.db.run_transaction(update)
    return CodexTokenStatus(
        configured=True,
        source="customer",
        updated_at=updated.updated_at.isoformat(),
    )


async def delete_codex_tokens(
    session: Uow, principal: Principal
) -> CodexTokenStatus:
    org_id = principal.org_id
    col = org_secrets_col(org_id)

    async def update(txn):
        doc = await txn.get(col, SECRETS_DOC_ID)
        current = OrgSecrets.from_doc(doc) if doc else OrgSecrets.empty(str(org_id))
        next_secrets = dict(current.secrets)
        next_secrets.pop("codexTokenBundle", None)
        updated = OrgSecrets(
            scope_id=str(org_id),
            secrets=next_secrets,
            selection={**current.selection, "codexTokenBundle": "customer"},
            created_at=current.created_at,
            updated_at=utcnow(),
        )
        txn.set(col, SECRETS_DOC_ID, updated.to_doc())
        return updated

    updated = await session.db.run_transaction(update)
    return CodexTokenStatus(
        configured=False,
        source="customer",
        updated_at=updated.updated_at.isoformat(),
    )


async def rotate_codex_tokens(
    session: Uow, org_id: uuid.UUID, body: CodexTokenRotateRequest
) -> CodexTokenRotateResponse:
    """Compare-and-swap a refreshed token set across proxy instances."""
    col = org_secrets_col(org_id)
    replacement = get_vault().encrypt_map(
        {"codexTokenBundle": _bundle_json(body.tokens)}
    )["codexTokenBundle"]

    async def update(txn):
        doc = await txn.get(col, SECRETS_DOC_ID)
        current = OrgSecrets.from_doc(doc) if doc else OrgSecrets.empty(str(org_id))
        encrypted = current.secrets.get("codexTokenBundle")
        if encrypted is None:
            # Only operator import may establish an initial credential.
            return None
        plaintext = get_vault().decrypt_map({"codexTokenBundle": encrypted})[
            "codexTokenBundle"
        ]
        existing = _parse_bundle(plaintext)
        if existing.obtained_at != body.expected_obtained_at:
            return (False, existing)
        next_record = OrgSecrets(
            scope_id=str(org_id),
            secrets={**current.secrets, "codexTokenBundle": replacement},
            selection={**current.selection, "codexTokenBundle": "customer"},
            created_at=current.created_at,
            updated_at=utcnow(),
        )
        txn.set(col, SECRETS_DOC_ID, next_record.to_doc())
        return (True, body.tokens)

    resolved = await session.db.run_transaction(update)
    if resolved is None:
        from app.errors import NotFoundError

        raise NotFoundError("Codex credentials are not configured")
    updated, tokens = resolved
    return CodexTokenRotateResponse(updated=updated, tokens=tokens)
