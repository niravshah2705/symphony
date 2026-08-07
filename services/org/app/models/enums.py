"""Enumerations used across models and the authorization layer."""
from __future__ import annotations

import enum


class OrgRole(str, enum.Enum):
    ORG_ADMIN = "ORG_ADMIN"
    MEMBER = "MEMBER"


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
