"""Settings-policy business logic.

Scope always derives from the authenticated Principal / resolved ProjectContext
— never from a path/body org id. An absent policy reads back as an empty policy
(no restriction). A PUT replaces the scope's policy DOMAINS but MERGES config
``values`` (they are write-only secrets the browser can never read back to
resend). The effective endpoint runs the org → project → user cascade for the
caller against the item universe.

Config values (provider API keys) are secrets: every browser-facing response
MASKS them to ``{set: bool}``. The plaintext is returned only by
``resolve_config_for_caller`` (the internal S2S endpoint).
"""
from __future__ import annotations

import uuid

from app.authz.guards import ProjectContext
from app.authz.principal import Principal
from app.core.database import Uow
from app.core.timeutils import utcnow
from app.domain import universe as universe_mod
from app.domain.resolver import (
    locked_pref_keys,
    resolve_effective,
    resolve_effective_prefs,
    resolve_effective_values,
)
from app.models.policy import (
    CONFIG_VALUE_KEYS,
    DomainPolicy,
    SettingsPolicy,
    clean_config_values,
    clean_locks,
    clean_prefs,
)
from app.repositories.base import (
    org_settings_col,
    project_settings_col,
    user_settings_col,
)
from app.repositories.policy_repo import PolicyRepository
from app.schemas.policy import (
    EffectiveDomainSchema,
    EffectiveResponse,
    InternalEffectiveConfigResponse,
    InternalEffectivePolicyResponse,
    MaskedConfigValue,
    PolicyResponse,
    PolicyUpdate,
    UniverseResponse,
)


def _mask_values(values: dict[str, str]) -> dict[str, MaskedConfigValue]:
    """Presence-only view for every allow-listed key — never the secret itself."""
    return {key: MaskedConfigValue(set=bool(values.get(key))) for key in CONFIG_VALUE_KEYS}


def _merge_values(current: dict[str, str], incoming: dict[str, str] | None) -> dict[str, str]:
    """Merge config values: ``None`` preserves everything; a provided non-empty
    string sets a key; a provided empty string clears it; unmentioned keys stay."""
    if incoming is None:
        return clean_config_values(current)
    merged = dict(clean_config_values(current))
    for key, value in incoming.items():
        if value:
            merged[key] = value
        else:
            merged.pop(key, None)
    return clean_config_values(merged)


def _merge_prefs(current: dict[str, str], incoming: dict[str, str] | None) -> dict[str, str]:
    """Merge operational prefs: same semantics as values (``None`` preserves;
    non-empty sets; empty clears; unmentioned stay). Readable, non-secret."""
    if incoming is None:
        return clean_prefs(current)
    merged = dict(clean_prefs(current))
    for key, value in incoming.items():
        if value:
            merged[key] = value
        else:
            merged.pop(key, None)
    return clean_prefs(merged)


def _to_response(policy: SettingsPolicy) -> PolicyResponse:
    return PolicyResponse(
        scope_type=policy.scope_type,
        scope_id=policy.scope_id,
        domains={
            name: {"include": dp.include, "exclude": dp.exclude}
            for name, dp in policy.domains.items()
        },
        values=_mask_values(policy.values),
        prefs=dict(policy.prefs),
        locks=list(policy.locks),
        updated_at=policy.updated_at,
    )


def _apply_update(
    scope_type: str,
    scope_id: str,
    body: PolicyUpdate,
    current: SettingsPolicy | None,
) -> SettingsPolicy:
    if body.domains is None:
        # Absent domains → preserve what is stored (independent of `values`).
        domains = dict(current.domains) if current else {}
    else:
        domains = {
            name: DomainPolicy(include=list(dp.include), exclude=list(dp.exclude))
            for name, dp in body.domains.items()
        }
    # Locks REPLACE (like domains): absent → preserve; provided (even []) → replace.
    if body.locks is None:
        locks = list(current.locks) if current else []
    else:
        locks = clean_locks(body.locks)
    return SettingsPolicy(
        scope_type=scope_type,
        scope_id=scope_id,
        domains=domains,
        values=_merge_values(current.values if current else {}, body.values),
        prefs=_merge_prefs(current.prefs if current else {}, body.prefs),
        locks=locks,
        updated_at=utcnow(),
    )


# ---- org scope --------------------------------------------------------------

async def get_org_policy(session: Uow, principal: Principal) -> PolicyResponse:
    org_id = principal.org_id
    policy = await PolicyRepository(session).get(org_settings_col(org_id))
    return _to_response(policy or SettingsPolicy.empty("org", str(org_id)))


async def set_org_policy(
    session: Uow, principal: Principal, body: PolicyUpdate
) -> PolicyResponse:
    org_id = principal.org_id
    col = org_settings_col(org_id)
    repo = PolicyRepository(session)
    current = await repo.get(col)
    policy = _apply_update("org", str(org_id), body, current)
    await repo.upsert(col, policy)
    return _to_response(policy)


# ---- project scope ----------------------------------------------------------

async def get_project_policy(session: Uow, ctx: ProjectContext) -> PolicyResponse:
    col = project_settings_col(ctx.org_id, ctx.project_id)
    policy = await PolicyRepository(session).get(col)
    return _to_response(policy or SettingsPolicy.empty("project", str(ctx.project_id)))


async def set_project_policy(
    session: Uow, ctx: ProjectContext, body: PolicyUpdate
) -> PolicyResponse:
    col = project_settings_col(ctx.org_id, ctx.project_id)
    repo = PolicyRepository(session)
    current = await repo.get(col)
    policy = _apply_update("project", str(ctx.project_id), body, current)
    await repo.upsert(col, policy)
    return _to_response(policy)


# ---- user scope -------------------------------------------------------------

async def get_user_policy(session: Uow, principal: Principal) -> PolicyResponse:
    col = user_settings_col(principal.user_id)
    policy = await PolicyRepository(session).get(col)
    return _to_response(policy or SettingsPolicy.empty("user", str(principal.user_id)))


async def set_user_policy(
    session: Uow, principal: Principal, body: PolicyUpdate
) -> PolicyResponse:
    col = user_settings_col(principal.user_id)
    repo = PolicyRepository(session)
    current = await repo.get(col)
    policy = _apply_update("user", str(principal.user_id), body, current)
    await repo.upsert(col, policy)
    return _to_response(policy)


# ---- cascade / universe -----------------------------------------------------

def get_universe() -> UniverseResponse:
    return UniverseResponse(domains=universe_mod.universe())


async def _load_scoped_policies(
    session: Uow, principal: Principal, project_id: uuid.UUID | None
) -> tuple[
    SettingsPolicy | None, SettingsPolicy | None, SettingsPolicy | None, uuid.UUID | None
]:
    """Fetch (org, project, user) policies scoped to the authenticated caller.

    A project_id the caller cannot access (org-less caller, or a project under a
    different org) is treated as absent — the org path is always addressed under
    the caller's OWN org namespace, so a foreign project id can never reach
    another org's data, and no existence oracle is exposed."""
    repo = PolicyRepository(session)

    org_policy = None
    if principal.org_id is not None:
        org_policy = await repo.get(org_settings_col(principal.org_id))

    project_policy = None
    resolved_project_id: uuid.UUID | None = None
    if project_id is not None and principal.org_id is not None:
        project_policy = await repo.get(
            project_settings_col(principal.org_id, project_id)
        )
        resolved_project_id = project_id

    user_policy = await repo.get(user_settings_col(principal.user_id))
    return org_policy, project_policy, user_policy, resolved_project_id


async def resolve_for_caller(
    session: Uow, principal: Principal, project_id: uuid.UUID | None
) -> EffectiveResponse:
    """Resolve the effective policy (and MASKED config values) for the caller,
    cascaded org → project → user."""
    org_policy, project_policy, user_policy, resolved_project_id = (
        await _load_scoped_policies(session, principal, project_id)
    )

    universe = universe_mod.universe()
    resolution = resolve_effective(universe, org_policy, project_policy, user_policy)
    effective_values = resolve_effective_values(org_policy, project_policy, user_policy)
    effective_prefs = resolve_effective_prefs(org_policy, project_policy, user_policy)
    return EffectiveResponse(
        project_id=resolved_project_id,
        domains={
            name: EffectiveDomainSchema(
                org=res.org, project=res.project, user=res.user, effective=res.effective
            )
            for name, res in resolution.items()
        },
        universe=universe,
        values=_mask_values(effective_values),
        prefs=effective_prefs,
        locks=locked_pref_keys(org_policy, project_policy),
    )


async def resolve_policy_for_org(
    session: Uow, org_id: uuid.UUID, project_id: uuid.UUID | None
) -> InternalEffectivePolicyResponse:
    """INTERNAL S2S ONLY. Resolve an ORG's effective policy (org → project
    cascade, NO user scope) for the autonomous planner/coder, which act for an org
    and carry no end-user token. Token-gated; the org_id route param IS the
    authorization scope (mirrors the org-secrets S2S resolver). The absence of a
    user scope means ``effective`` is the org(+project)-level allowed set."""
    repo = PolicyRepository(session)
    org_policy = await repo.get(org_settings_col(org_id))
    project_policy = None
    resolved_project_id: uuid.UUID | None = None
    if project_id is not None:
        project_policy = await repo.get(project_settings_col(org_id, project_id))
        resolved_project_id = project_id

    universe = universe_mod.universe()
    resolution = resolve_effective(universe, org_policy, project_policy, None)
    return InternalEffectivePolicyResponse(
        project_id=resolved_project_id,
        domains={
            name: EffectiveDomainSchema(
                org=res.org, project=res.project, user=res.user, effective=res.effective
            )
            for name, res in resolution.items()
        },
        prefs=resolve_effective_prefs(org_policy, project_policy, None),
    )


async def resolve_config_for_caller(
    session: Uow, principal: Principal, project_id: uuid.UUID | None
) -> InternalEffectiveConfigResponse:
    """INTERNAL S2S ONLY. Resolve the caller's effective config values as
    PLAINTEXT so the gateway/planner can wire the provider key into the harness.
    Scope still derives from the authenticated principal (never caller-supplied
    org ids); the endpoint is guarded by being non-browser-reachable + IAM."""
    org_policy, project_policy, user_policy, resolved_project_id = (
        await _load_scoped_policies(session, principal, project_id)
    )
    effective_values = resolve_effective_values(org_policy, project_policy, user_policy)
    return InternalEffectiveConfigResponse(
        project_id=resolved_project_id, values=effective_values
    )
