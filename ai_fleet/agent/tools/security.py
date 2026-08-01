"""Security tools (port of agent/tools/security.js).

Run established scanners over the workspace. Everything delegates to a
pre-installed scanner (Trivy, npm audit, pip-audit, Semgrep, gitleaks,
TruffleHog); we never re-implement detection rules.

Secret hygiene: the secret scanner is invoked in REDACT mode (gitleaks
``--redact``, TruffleHog ``--only-verified``) and all tool output additionally
passes through the registry's secret redactor, so found secrets are not echoed
verbatim to the model.
"""

from __future__ import annotations

import os
from typing import Literal, Optional

from pydantic import BaseModel, Field

from ai_fleet.agent.tools.exec import (
    command_exists,
    define_tool,
    exec_tool,
    platform_cmd,
    resolve_workdir,
)


async def pick_vuln_scanner(dir, requested=None):
    """Pick a dependency/vuln scanner given availability + detected ecosystem."""
    def has(f):
        return os.path.exists(os.path.join(dir, f))

    scanners = {
        "trivy": {
            "command": "trivy",
            "args": ["fs", "--scanners", "vuln,misconfig,secret", "--exit-code", "0", "."],
            "hint": "Install Trivy (https://aquasecurity.github.io/trivy).",
        },
        "npm-audit": {"command": platform_cmd("npm"), "args": ["audit"], "hint": "Install Node.js (bundles npm)."},
        "pip-audit": {"command": "pip-audit", "args": [], "hint": "pip install pip-audit."},
        "semgrep": {"command": "semgrep", "args": ["scan", "--config", "auto", "--error"], "hint": "Install Semgrep (pip install semgrep)."},
    }
    if requested and requested != "auto":
        return {"key": requested, **scanners[requested]}
    if await command_exists("trivy"):
        return {"key": "trivy", **scanners["trivy"]}
    if has("package.json"):
        return {"key": "npm-audit", **scanners["npm-audit"]}
    if (has("requirements.txt") or has("pyproject.toml")) and (await command_exists("pip-audit")):
        return {"key": "pip-audit", **scanners["pip-audit"]}
    if await command_exists("semgrep"):
        return {"key": "semgrep", **scanners["semgrep"]}
    return {"key": "npm-audit", **scanners["npm-audit"]}  # last resort; reports "not installed" cleanly


class _SecurityScanSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative directory")
    scanner: Optional[Literal["auto", "trivy", "npm-audit", "pip-audit", "semgrep"]] = Field(
        default=None, description="force a scanner (default: auto)"
    )


class _SecretScanSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative directory")


async def _security_scan(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    scanner = await pick_vuln_scanner(dir_, input.get("scanner"))
    return await exec_tool(
        ctx=ctx,
        label=f"security scan ({scanner['key']})",
        command=scanner["command"],
        args=scanner["args"],
        dir=input.get("dir"),
        not_found_hint=scanner["hint"],
    )


async def _secret_scan(input, ctx):
    if await command_exists("gitleaks", "version"):
        return await exec_tool(
            ctx=ctx,
            label="secret scan (gitleaks)",
            command="gitleaks",
            args=["detect", "--no-banner", "--redact", "--source", "."],
            dir=input.get("dir"),
        )
    return await exec_tool(
        ctx=ctx,
        label="secret scan (trufflehog)",
        command="trufflehog",
        args=["filesystem", ".", "--only-verified", "--no-update"],
        dir=input.get("dir"),
        not_found_hint="Install gitleaks (preferred) or TruffleHog to scan for committed secrets.",
    )


security_scan_tool = define_tool(
    {
        "name": "security_scan",
        "description": (
            "Scan the workspace for dependency vulnerabilities and misconfigurations using the best available scanner "
            "(Trivy, npm audit, pip-audit, or Semgrep). Prefer this over ad-hoc grepping for CVEs."
        ),
        "schema": _SecurityScanSchema,
    },
    _security_scan,
)

secret_scan_tool = define_tool(
    {
        "name": "secret_scan",
        "description": (
            "Scan the workspace for committed secrets/credentials with gitleaks or TruffleHog (run in redacted mode). "
            "Use before opening a PR to catch leaked keys."
        ),
        "schema": _SecretScanSchema,
    },
    _secret_scan,
)

FACTORIES = {"security_scan": security_scan_tool, "secret_scan": secret_scan_tool}
