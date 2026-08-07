"""Collection-path helpers for the Firestore repositories.

Tenant isolation is structural: org-owned policies live under
``organizations/{org_id}/...``. Top-level ``users`` carries an ``org_id`` field
(None for org-less identities). Each scope keeps a single policy document
(``POLICY_DOC_ID``) inside its ``.../settings`` collection.
"""
from __future__ import annotations

import uuid

# Top-level collections
ORGS = "organizations"
USERS = "users"
UNIQUE_EMAILS = "unique_emails"
UNIQUE_EXTERNAL_SUBJECTS = "unique_external_subjects"


def org_settings_col(org_id: uuid.UUID) -> str:
    return f"{ORGS}/{org_id}/settings"


def project_settings_col(org_id: uuid.UUID, project_id: uuid.UUID) -> str:
    return f"{ORGS}/{org_id}/projects/{project_id}/settings"


def user_settings_col(user_id: uuid.UUID) -> str:
    return f"{USERS}/{user_id}/settings"


def memberships_col(org_id: uuid.UUID) -> str:
    return f"{ORGS}/{org_id}/memberships"
