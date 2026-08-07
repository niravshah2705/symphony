"""The item universe per settings domain.

These are the concrete items a policy's include/exclude patterns match against
and the base set the cascade resolver narrows. They mirror the platform's
JS-side catalogs so the effective set means the same thing on both sides:

- harness — the agent-runtime ids (packages/shared/src/agent/runtimes.js RUNTIMES)
- tools   — the developer-tool registry domains (packages/shared/src/agent/tools/index.js DOMAINS)
- skills  — the vendored core-workflow skills (packages/shared/src/agent/skills/SKILLS.md)
- plugins — an operator-configurable list (SETTINGS_PLUGINS_CATALOG)

Kept in sync manually and deliberately: this service is a standalone Python app
and does not import the Node catalogs. If a runtime/tool/skill is added on the JS
side, add it here too (and the resolver will start governing it).
"""
from __future__ import annotations

from app.core.config import get_settings

# Agent-runtime ids (RUNTIMES keys in runtimes.js).
HARNESS: tuple[str, ...] = ("deepagent", "codex-sdk", "claude-agent-sdk", "antigravity-sdk")

# Developer-tool registry domain names (DOMAINS keys in tools/index.js).
TOOLS: tuple[str, ...] = (
    "docker",
    "environments",
    "build",
    "android",
    "security",
    "quality",
    "codegen",
    "playwright",
)

# Vendored core-workflow skill ids (skills/SKILLS.md, section 1).
SKILLS: tuple[str, ...] = (
    "linear",
    "software-planning",
    "web-research",
    "pull",
    "commit",
    "push",
    "land",
)


def universe() -> dict[str, list[str]]:
    """The item universe for every domain. Plugins come from config."""
    return {
        "harness": list(HARNESS),
        "tools": list(TOOLS),
        "skills": list(SKILLS),
        "plugins": get_settings().plugins_catalog(),
    }
