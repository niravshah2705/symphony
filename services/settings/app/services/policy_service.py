"""Settings-policy business logic.

Scope always derives from the authenticated Principal / resolved ProjectContext
— never from a path/body org id. An absent policy reads back as an empty policy
(no restriction). PUT replaces the scope's policy with exactly the domains
supplied. The effective endpoint runs the org → project → user cascade for the
caller against the item universe.
"""
from __future__ import annotations

import uuid

from app.authz.guards import ProjectContext
from app.authz.principal import Principal
from app.core.database import Uow
from app.core.timeutils import utcnow
from app.domain import universe as universe_mod
from app.domain.resolver import resolve_effective
from app.models.policy import DomainPolicy, SettingsPolicy
from app.repositories.base import (
    org_settings_col,
    project_settings_col,
    user_settings_col,
)
from app.repositories.policy_repo import PolicyRepository
from app.schemas.policy import (
    EffectiveDomainSchema,
    EffectiveResponse,
    PolicyResponse,
    PolicyUpdate,
    UniverseResponse,
)


def _to_response(policy: SettingsPolicy) -> PolicyResponse:
    return PolicyResponse(
        scope_type=policy.scope_type,
        scope_id=policy.scope_id,
        domains={
            name: {"include": dp.include, "exclude": dp.exclude}
            for name, dp in policy.domains.items()
        },
        updated_at=policy.updated_at,
    )


def _apply_update(scope_type: str, scope_id: str, body: PolicyUpdate) -> SettingsPolicy:
    domains = {
        name: DomainPolicy(include=list(dp.include), exclude=list(dp.exclude))
        for name, dp in body.domains.items()
    }
    return SettingsPolicy(
        scope_type=scope_type, scope_id=scope_id, domains=domains, updated_at=utcnow()
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
    policy = _apply_update("org", str(org_id), body)
    await PolicyRepository(session).upsert(org_settings_col(org_id), policy)
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
    policy = _apply_update("project", str(ctx.project_id), body)
    await PolicyRepository(session).upsert(col, policy)
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
    policy = _apply_update("user", str(principal.user_id), body)
    await PolicyRepository(session).upsert(col, policy)
    return _to_response(policy)


# ---- cascade / universe -----------------------------------------------------

def get_universe() -> UniverseResponse:
    return UniverseResponse(domains=universe_mod.universe())


async def resolve_for_caller(
    session: Uow, principal: Principal, project_id: uuid.UUID | None
) -> EffectiveResponse:
    """Resolve the effective policy for the caller: their org policy, the given
    project's policy (only if resolvable within the caller's org), and the
    caller's own user policy, cascaded org → project → user.

    A project_id the caller cannot access is treated as absent (no project layer)
    rather than raising — the effective set still reflects org + user. This keeps
    the endpoint safe from being used as a cross-org existence oracle."""
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

    universe = universe_mod.universe()
    resolution = resolve_effective(universe, org_policy, project_policy, user_policy)
    return EffectiveResponse(
        project_id=resolved_project_id,
        domains={
            name: EffectiveDomainSchema(
                org=res.org, project=res.project, user=res.user, effective=res.effective
            )
            for name, res in resolution.items()
        },
        universe=universe,
    )
