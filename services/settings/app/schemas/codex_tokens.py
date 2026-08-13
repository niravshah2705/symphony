"""Validated Codex OAuth bundle contracts for the direct operator surface."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.policy import _CONTROL_CHARS_RE

MAX_TOKEN_LENGTH = 32768


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part.capitalize() for part in tail)


class CodexTokenBundle(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_camel)

    access_token: str = ""
    refresh_token: str = ""
    id_token: str = ""
    token_type: str = "Bearer"
    scope: str = "openid profile email offline_access"
    expires_at: int
    obtained_at: int

    @field_validator("access_token", "refresh_token", "id_token", "token_type", "scope")
    @classmethod
    def _safe_token_text(cls, value: str) -> str:
        text = str(value).strip()
        if len(text) > MAX_TOKEN_LENGTH:
            raise ValueError("token field is too long")
        if _CONTROL_CHARS_RE.search(text):
            raise ValueError("token field contains control characters")
        return text

    @field_validator("expires_at", "obtained_at")
    @classmethod
    def _positive_timestamp(cls, value: int) -> int:
        number = int(value)
        if number <= 0:
            raise ValueError("token timestamps must be positive epoch milliseconds")
        return number

    @model_validator(mode="after")
    def _usable(self):
        if not self.access_token and not self.refresh_token:
            raise ValueError("an access or refresh token is required")
        return self


class CodexTokenImportRequest(BaseModel):
    tokens: CodexTokenBundle


class CodexTokenStatus(BaseModel):
    configured: bool
    source: str = "customer"
    updated_at: str | None = None


class CodexTokenRotateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_camel)

    expected_obtained_at: int
    tokens: CodexTokenBundle


class CodexTokenRotateResponse(BaseModel):
    updated: bool
    tokens: CodexTokenBundle
