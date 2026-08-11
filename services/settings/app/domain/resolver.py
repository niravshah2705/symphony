"""The include/exclude cascade resolver — the heart of the service.

Rule (see README): **exclude at org blocks project AND user; exclude at project
blocks user; a lower scope can only NARROW, never re-include what a higher scope
excluded. Exclude always wins downward.**

The rule is enforced structurally, not by special-casing: each scope resolves
*within* the set the scope above already allowed. Because a lower scope only ever
filters that already-narrowed set, its ``include`` can never re-introduce an item
a higher scope removed, and its ``exclude`` only removes more.

Per scope, for a domain:
    base    = candidates                     if include is empty
            = [c in candidates matching any include pattern]   otherwise
    allowed = [b in base not matching any exclude pattern]

Patterns are glob (fnmatch, case-sensitive), so ``security:*`` matches
``security:raven`` etc.
"""
from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatchcase

from app.models.policy import (
    CONFIG_VALUE_KEYS,
    DOMAINS,
    LOCKABLE_KEYS,
    PREF_KEYS,
    DomainPolicy,
    SettingsPolicy,
)


def _matches_any(item: str, patterns: list[str]) -> bool:
    return any(fnmatchcase(item, pattern) for pattern in patterns)


def apply_scope(candidates: list[str], scope: DomainPolicy) -> list[str]:
    """Narrow ``candidates`` by one scope's include/exclude. Order-preserving.

    An empty ``include`` means 'keep all candidates' (before exclusions). A
    non-empty ``include`` keeps only candidates matching an include pattern.
    ``exclude`` always removes, and wins over ``include``.
    """
    if scope.include:
        base = [c for c in candidates if _matches_any(c, scope.include)]
    else:
        base = list(candidates)
    return [c for c in base if not _matches_any(c, scope.exclude)]


@dataclass(frozen=True)
class DomainResolution:
    """The allowed set at each scope for one domain. ``effective`` is the
    fully-cascaded (user-level) set the caller is actually granted."""

    org: list[str]
    project: list[str]
    user: list[str]

    @property
    def effective(self) -> list[str]:
        return self.user


def resolve_domain(
    universe: list[str],
    org: DomainPolicy,
    project: DomainPolicy,
    user: DomainPolicy,
) -> DomainResolution:
    """Cascade one domain: universe → org → project → user."""
    org_allowed = apply_scope(universe, org)
    project_allowed = apply_scope(org_allowed, project)
    user_allowed = apply_scope(project_allowed, user)
    return DomainResolution(org=org_allowed, project=project_allowed, user=user_allowed)


_EMPTY = DomainPolicy()


def resolve_effective(
    universe_by_domain: dict[str, list[str]],
    org_policy: SettingsPolicy | None,
    project_policy: SettingsPolicy | None,
    user_policy: SettingsPolicy | None,
) -> dict[str, DomainResolution]:
    """Resolve every domain's cascade. Missing policies are treated as empty
    (no restriction at that scope)."""

    def scope(policy: SettingsPolicy | None, domain: str) -> DomainPolicy:
        return policy.domain(domain) if policy is not None else _EMPTY

    org_locks = set(org_policy.locks) if org_policy is not None else set()
    project_locks = set(project_policy.locks) if project_policy is not None else set()

    result: dict[str, DomainResolution] = {}
    for domain in DOMAINS:
        universe = universe_by_domain.get(domain, [])
        # A domain LOCK freezes that domain at the locking scope: lower scopes are
        # ignored so they can't narrow it further. (Org lock → project+user out;
        # project lock → user out.)
        project_scope = _EMPTY if domain in org_locks else scope(project_policy, domain)
        user_scope = _EMPTY if domain in org_locks or domain in project_locks else scope(user_policy, domain)
        result[domain] = resolve_domain(
            universe,
            scope(org_policy, domain),
            project_scope,
            user_scope,
        )
    return result


def resolve_effective_values(
    org_policy: SettingsPolicy | None,
    project_policy: SettingsPolicy | None,
    user_policy: SettingsPolicy | None,
) -> dict[str, str]:
    """Resolve each allow-listed config value with **user > project > org**
    precedence — a lower scope overrides a higher one (the opposite direction of
    the include/exclude narrowing, because config values are overrides, not
    restrictions). Only keys with a non-empty value at some scope are returned.
    """

    def values(policy: SettingsPolicy | None) -> dict[str, str]:
        return policy.values if policy is not None else {}

    org_values = values(org_policy)
    project_values = values(project_policy)
    user_values = values(user_policy)

    effective: dict[str, str] = {}
    for key in CONFIG_VALUE_KEYS:
        # Lowest scope with a value wins.
        for source in (user_values, project_values, org_values):
            candidate = source.get(key)
            if candidate:
                effective[key] = candidate
                break
    return effective


def locked_keys(
    org_policy: SettingsPolicy | None,
    project_policy: SettingsPolicy | None,
) -> list[str]:
    """Lock entries (pref keys and/or domain names) a USER cannot change — the
    union of locks set at org and project. Order-stable (LOCKABLE_KEYS order) so
    the response is deterministic."""
    locked: set[str] = set()
    if org_policy is not None:
        locked.update(org_policy.locks)
    if project_policy is not None:
        locked.update(project_policy.locks)
    return [key for key in LOCKABLE_KEYS if key in locked]


def resolve_effective_prefs(
    org_policy: SettingsPolicy | None,
    project_policy: SettingsPolicy | None,
    user_policy: SettingsPolicy | None,
) -> dict[str, str]:
    """Resolve each allow-listed operational pref. Default precedence is
    **user > project > org** (a lower scope overrides a higher one). A LOCK
    inverts that for the locked key: a key locked at ORG resolves from org only
    (project/user ignored); locked at PROJECT resolves project→org (user ignored).
    Only keys set at some considered scope are returned."""

    org_prefs = org_policy.prefs if org_policy is not None else {}
    project_prefs = project_policy.prefs if project_policy is not None else {}
    user_prefs = user_policy.prefs if user_policy is not None else {}
    org_locks = set(org_policy.locks) if org_policy is not None else set()
    project_locks = set(project_policy.locks) if project_policy is not None else set()

    effective: dict[str, str] = {}
    for key in PREF_KEYS:
        if key in org_locks:
            sources = (org_prefs,)  # org pinned it — nothing below can override
        elif key in project_locks:
            sources = (project_prefs, org_prefs)  # project pinned it — user ignored
        else:
            sources = (user_prefs, project_prefs, org_prefs)  # default override order
        for source in sources:
            candidate = source.get(key)
            if candidate:
                effective[key] = candidate
                break
    return effective
