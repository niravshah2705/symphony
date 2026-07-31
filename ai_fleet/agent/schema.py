"""Structured-output contract for the enrichment deep agent (port of agent/schema.js).

The LLM output is untrusted. We validate it against these pydantic models (schema
validation) and additionally normalize/clamp it before any Linear write, so a
hallucinated or injection-influenced response cannot create unbounded resources
or reference out-of-range dependency indices.
"""

from __future__ import annotations

import re
from typing import Optional

from pydantic import BaseModel, Field

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

TSHIRT_SIZES = ["XS", "S", "M", "L", "XL"]


def normalize_tshirt_size(size) -> str:
    """Clamp a model-provided size to a valid T-shirt size (uppercase); default 'M'."""
    s = str(size or "").strip().upper()
    return s if s in TSHIRT_SIZES else "M"


class IssueSchema(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    description: str = Field(default="", max_length=8000)
    priority: int = Field(default=3, ge=0, le=4)
    evaluationCriteria: str = Field(default="", max_length=2400)
    estimateDays: Optional[int] = Field(default=None, ge=1, le=90)
    tshirtSize: str = Field(default="M", max_length=20)


class MilestoneSchema(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=2000)
    startDate: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    targetDate: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    evaluationCriteria: str = Field(default="", max_length=1500)
    issues: list[IssueSchema] = Field(default_factory=list)


class DependencySchema(BaseModel):
    fromMilestone: int = Field(ge=0)
    fromIssue: int = Field(ge=0)
    toMilestone: int = Field(ge=0)
    toIssue: int = Field(ge=0)
    reason: Optional[str] = Field(default=None, max_length=300)


class PlanSchema(BaseModel):
    description: str = Field(min_length=10, max_length=6000)
    milestones: list[MilestoneSchema] = Field(min_length=1)
    dependencies: list[DependencySchema] = Field(default_factory=list)


class ViabilitySchema(BaseModel):
    """Business-owner viability verdict for a project (step 1 of planning)."""

    viable: bool
    reason: str = Field(min_length=3, max_length=800)


class _ResumeMilestone(BaseModel):
    name: str
    evaluationCriteria: str = Field(default="", max_length=1500)
    issues: list[IssueSchema] = Field(default_factory=list)


class ResumeSchema(BaseModel):
    """Tasks generated for existing milestones (resume path)."""

    milestones: list[_ResumeMilestone]


def plan_json_schema() -> dict:
    """Convert the schema to plain JSON Schema for the LLM response format."""
    return PlanSchema.model_json_schema()


def _normalize_dates(start_date: str, target_date: str) -> dict:
    if start_date and target_date and target_date < start_date:
        return {"startDate": target_date, "targetDate": start_date}
    return {"startDate": start_date, "targetDate": target_date}


def normalize_plan(plan, limits: dict) -> dict:
    """Clamp/sanitize a validated plan to the configured limits and drop
    dependencies whose indices fall outside the milestone/issue matrix.

    ``plan`` may be a PlanSchema instance or a plain dict.
    """
    if isinstance(plan, PlanSchema):
        plan = plan.model_dump()

    max_milestones = max(1, limits.get("maxMilestones") or 6)
    max_issues = max(0, limits.get("maxIssuesPerMilestone") or 5)

    milestones = []
    for m in plan["milestones"][:max_milestones]:
        merged = {**m, **_normalize_dates(m.get("startDate"), m.get("targetDate"))}
        merged["issues"] = m.get("issues", [])[:max_issues]
        milestones.append(merged)

    def _keep(d) -> bool:
        from_m = milestones[d["fromMilestone"]] if d["fromMilestone"] < len(milestones) else None
        to_m = milestones[d["toMilestone"]] if d["toMilestone"] < len(milestones) else None
        if not from_m or not to_m:
            return False
        if d["fromIssue"] >= len(from_m["issues"]) or d["toIssue"] >= len(to_m["issues"]):
            return False
        return not (d["fromMilestone"] == d["toMilestone"] and d["fromIssue"] == d["toIssue"])

    dependencies = [d for d in (plan.get("dependencies") or []) if _keep(d)]
    return {"description": plan["description"], "milestones": milestones, "dependencies": dependencies}
