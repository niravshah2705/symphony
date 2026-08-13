"""Secret-free pipeline preflight request/response contracts."""
from __future__ import annotations

import re
import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

PipelineStage = Literal["plan", "code", "test", "deploy"]
STAGE_ORDER = ("plan", "code", "test", "deploy")
_PROVIDER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,79}$")
_MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")


class PreflightRequest(BaseModel):
    project_id: uuid.UUID | None = None
    stages: list[PipelineStage] = Field(default_factory=lambda: ["plan", "code"])
    harnesses: dict[str, str] = Field(default_factory=dict)
    # The gateway owns the SDK-free model-role store. It supplies the exact
    # provider + catalog model id selected for each stage so this service can
    # apply the initiating user's models policy and credential readiness to the
    # decision that will actually execute.
    providers: dict[str, str] = Field(default_factory=dict)
    models: dict[str, str] = Field(default_factory=dict)

    @field_validator("stages")
    @classmethod
    def _ordered_stages(cls, stages: list[str]) -> list[str]:
        if not stages or len(stages) > len(STAGE_ORDER) or len(set(stages)) != len(stages):
            raise ValueError("stages must be a non-empty ordered subset")
        positions = [STAGE_ORDER.index(stage) for stage in stages]
        if positions != sorted(positions):
            raise ValueError("stages must follow plan, code, test, deploy order")
        return stages

    @field_validator("harnesses")
    @classmethod
    def _known_harness_overrides(cls, values: dict[str, str]) -> dict[str, str]:
        unknown = set(values) - set(STAGE_ORDER)
        if unknown:
            raise ValueError(f"unknown harness stage(s): {', '.join(sorted(unknown))}")
        cleaned: dict[str, str] = {}
        for stage, value in values.items():
            runtime = str(value).strip().lower()
            if not runtime or len(runtime) > 100:
                raise ValueError(f"invalid harness for {stage}")
            cleaned[stage] = runtime
        return cleaned

    @field_validator("providers")
    @classmethod
    def _known_provider_overrides(cls, values: dict[str, str]) -> dict[str, str]:
        unknown = set(values) - set(STAGE_ORDER)
        if unknown:
            raise ValueError(f"unknown provider stage(s): {', '.join(sorted(unknown))}")
        cleaned: dict[str, str] = {}
        for stage, value in values.items():
            provider = str(value).strip().lower()
            if not _PROVIDER_RE.fullmatch(provider):
                raise ValueError(f"invalid provider for {stage}")
            cleaned[stage] = provider
        return cleaned

    @field_validator("models")
    @classmethod
    def _known_model_overrides(cls, values: dict[str, str]) -> dict[str, str]:
        unknown = set(values) - set(STAGE_ORDER)
        if unknown:
            raise ValueError(f"unknown model stage(s): {', '.join(sorted(unknown))}")
        cleaned: dict[str, str] = {}
        for stage, value in values.items():
            model_id = str(value).strip().lower()
            if not _MODEL_ID_RE.fullmatch(model_id):
                raise ValueError(f"invalid model for {stage}")
            cleaned[stage] = model_id
        return cleaned

    @model_validator(mode="after")
    def _deploy_requires_full_pipeline(self):
        if "deploy" in self.stages and tuple(self.stages) != STAGE_ORDER:
            raise ValueError(
                "deploy requires the exact full sequence: plan, code, test, deploy"
            )
        for field_name, values in (
            ("harnesses", self.harnesses),
            ("providers", self.providers),
            ("models", self.models),
        ):
            unrequested = set(values) - set(self.stages)
            if unrequested:
                raise ValueError(
                    f"{field_name} contains unrequested stage(s): "
                    f"{', '.join(sorted(unrequested))}"
                )
        return self


class CredentialReadiness(BaseModel):
    ready: bool
    source: str | None = None
    # Secret-free identifier for the credential family selected by preflight.
    # The gateway uses this to ensure the deployed proxy backend can consume it.
    kind: str | None = None


class StageDecision(BaseModel):
    stage: PipelineStage
    workflow: str
    harness: str
    provider: str | None = None
    model: str | None = None
    allowed: bool
    available: bool
    supported: bool
    brokered: bool
    credential: CredentialReadiness
    errors: list[str] = Field(default_factory=list)


class PreflightResponse(BaseModel):
    schema_version: int = 1
    decision_id: str
    project_id: uuid.UUID | None = None
    ready: bool
    prefs: dict[str, str] = Field(default_factory=dict)
    locks: list[str] = Field(default_factory=list)
    # Effective item sets only (no secrets), captured at the initiating user's
    # scope so later autonomous services never broaden to org-only policy.
    domains: dict[str, list[str]] = Field(default_factory=dict)
    stages: list[StageDecision]
