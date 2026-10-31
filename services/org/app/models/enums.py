"""Enumerations used across models and the authorization layer."""
from __future__ import annotations

import enum


class OrgRole(str, enum.Enum):
    ORG_ADMIN = "ORG_ADMIN"
    MEMBER = "MEMBER"


class MembershipStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"


class InvitationStatus(str, enum.Enum):
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    REVOKED = "REVOKED"
    EXPIRED = "EXPIRED"


class ProjectRole(str, enum.Enum):
    PROJECT_ADMIN = "PROJECT_ADMIN"
    TEAM_LEAD = "TEAM_LEAD"
    DEVELOPER = "DEVELOPER"


class AuthProvider(str, enum.Enum):
    LOCAL = "LOCAL"
    EXTERNAL = "EXTERNAL"


class TaskStatus(str, enum.Enum):
    TODO = "TODO"
    IN_PROGRESS = "IN_PROGRESS"
    IN_REVIEW = "IN_REVIEW"
    DONE = "DONE"


class Persona(str, enum.Enum):
    ENGINEER = "ENGINEER"
    CLIENT = "CLIENT"
    # Deliberately not "ADMIN" — avoids reading next to OrgRole.ORG_ADMIN as if
    # it were the same axis. Persona is "what kind of person is this," OrgRole
    # is "what can they do."
    ORG_MANAGER = "ORG_MANAGER"


class ProjectAccessMode(str, enum.Enum):
    INVITE_ONLY = "INVITE_ONLY"  # default — matches today's actual behavior
    ORG_WIDE = "ORG_WIDE"  # every member of the project's own org has access
