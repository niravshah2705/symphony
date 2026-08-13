"""Durable, org-scoped deployment approval contracts."""
from __future__ import annotations

import re
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
COMMAND_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ENVIRONMENT_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
GITHUB_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part.capitalize() for part in tail)


class _ApprovalBase(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_camel)

    project_id: uuid.UUID
    repository: str
    environment: str
    test_command_id: str
    commit_sha: str
    tree_sha: str
    preflight_decision_digest: str

    @field_validator("repository")
    @classmethod
    def _github_repository(cls, value: str) -> str:
        normalized = str(value).strip()
        if not REPOSITORY_RE.fullmatch(normalized):
            raise ValueError("repository must be a GitHub owner/name")
        return normalized

    @field_validator("environment")
    @classmethod
    def _environment(cls, value: str) -> str:
        normalized = str(value).strip().lower()
        if not ENVIRONMENT_RE.fullmatch(normalized):
            raise ValueError("environment is invalid")
        return normalized

    @field_validator("test_command_id")
    @classmethod
    def _test_command_id(cls, value: str) -> str:
        normalized = str(value).strip()
        if not COMMAND_ID_RE.fullmatch(normalized) or ":test:" not in normalized:
            raise ValueError("test_command_id must be a pipeline test command id")
        return normalized

    @field_validator("commit_sha", "tree_sha")
    @classmethod
    def _github_sha(cls, value: str) -> str:
        normalized = str(value).strip().lower()
        if not GITHUB_SHA_RE.fullmatch(normalized):
            raise ValueError("artifact SHA must be a 40-character lowercase GitHub SHA")
        return normalized

    @field_validator("preflight_decision_digest")
    @classmethod
    def _preflight_digest(cls, value: str) -> str:
        normalized = str(value).strip().lower()
        if not SHA256_RE.fullmatch(normalized):
            raise ValueError("preflight_decision_digest must be a SHA-256 digest")
        return normalized


class DeploymentApprovalCreateRequest(_ApprovalBase):
    expires_in_minutes: int = Field(default=240, ge=5, le=1440)


class DeploymentApprovalConsumeRequest(_ApprovalBase):
    test_completed_at: datetime


class DeploymentApprovalResponse(_ApprovalBase):
    approval_id: str
    run_id: str
    approved: bool = True
    approved_by: str
    approved_at: datetime
    expires_at: datetime
    consumed_at: datetime | None = None


def validate_run_id(value: str) -> str:
    normalized = str(value).strip()
    if not RUN_ID_RE.fullmatch(normalized):
        raise ValueError("run_id is invalid")
    return normalized
