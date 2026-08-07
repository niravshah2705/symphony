"""Enumerations used across models and the authorization layer.

Kept aligned with the org service so a Principal resolved from a shared Firebase
identity carries the same roles here.
"""
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
