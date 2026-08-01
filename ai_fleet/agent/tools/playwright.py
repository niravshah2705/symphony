"""Playwright tool (port of agent/tools/playwright.js).

Run the project's Playwright end-to-end suite by delegating to the Playwright
test runner (``npx playwright test``). No browser-driving logic is
re-implemented.

For INTERACTIVE browser automation (navigate/click/snapshot), the agent gets the
Playwright MCP server's tools instead — enable it with PLAYWRIGHT_MCP_ENABLED=true
(see config MCP.playwright + mcp.js). This tool covers the "run the suite" path;
the MCP server covers step-by-step control.
"""

from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field

from ai_fleet.agent.tools.exec import define_tool, exec_tool, platform_cmd

REPORTERS = {"list", "line", "dot", "html", "json", "junit", "github", "blob"}
PROJECT_RE = re.compile(r"^[A-Za-z0-9][\w .-]{0,64}$", re.ASCII)


class _PlaywrightTestSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative directory containing the Playwright project")
    project: Optional[str] = Field(default=None, description="Playwright project name (--project)")
    grep: Optional[str] = Field(default=None, description="only run tests whose title matches this pattern (--grep)")
    headed: Optional[bool] = Field(default=None, description="run headed (default: headless)")
    reporter: Optional[Literal["list", "line", "dot", "html", "json", "junit", "github", "blob"]] = Field(
        default=None, description="reporter"
    )


async def _playwright_test(input, ctx):
    args = ["--no-install", "playwright", "test"]
    if input.get("project"):
        if not PROJECT_RE.match(input["project"]):
            raise Exception(f'invalid project name: "{input["project"]}"')
        args.append(f"--project={input['project']}")
    if input.get("grep"):
        args.extend(["--grep", str(input["grep"])[:200]])
    if input.get("headed"):
        args.append("--headed")
    if input.get("reporter") and input["reporter"] in REPORTERS:
        args.append(f"--reporter={input['reporter']}")
    return await exec_tool(
        ctx=ctx,
        label="playwright test",
        command=platform_cmd("npx"),
        args=args,
        dir=input.get("dir"),
        not_found_hint="Add Playwright to the project (npm i -D @playwright/test && npx playwright install).",
    )


playwright_test_tool = define_tool(
    {
        "name": "playwright_test",
        "description": (
            "Run Playwright end-to-end tests (`playwright test`) in the workspace. Optionally filter by project or "
            "test-title pattern. Prefer this over invoking browsers directly; for interactive control use the Playwright MCP tools."
        ),
        "schema": _PlaywrightTestSchema,
    },
    _playwright_test,
)

FACTORIES = {"playwright_test": playwright_test_tool}
