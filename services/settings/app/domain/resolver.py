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

from app.models.policy import DOMAINS, DomainPolicy, SettingsPolicy


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

    result: dict[str, DomainResolution] = {}
    for domain in DOMAINS:
        universe = universe_by_domain.get(domain, [])
        result[domain] = resolve_domain(
            universe,
            scope(org_policy, domain),
            scope(project_policy, domain),
            scope(user_policy, domain),
        )
    return result
