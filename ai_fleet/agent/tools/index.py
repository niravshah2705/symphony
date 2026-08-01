"""Aggregate registry for the developer-tool folder (port of agent/tools/index.js).

Each domain module exports a ``FACTORIES`` map of ``{tool_name: (ctx) -> LangChainTool}``.
This index merges them into a single ``TOOL_FACTORIES`` map that ``../tools.py``
spreads into the framework's tool registry, so a workflow can reference any tool
by name in its ``tools: [...]`` array.

To add "many more" tools: create ``tools/<domain>.py`` exporting a ``FACTORIES``
map, then add it to ``DOMAINS`` below. Nothing else changes.
"""

from __future__ import annotations

from ai_fleet.agent.tools import (
    android,
    build,
    codegen,
    docker,
    environments,
    playwright,
    quality,
    security,
)

DOMAINS = {
    "docker": docker.FACTORIES,
    "environments": environments.FACTORIES,
    "build": build.FACTORIES,
    "android": android.FACTORIES,
    "security": security.FACTORIES,
    "quality": quality.FACTORIES,
    "codegen": codegen.FACTORIES,
    "playwright": playwright.FACTORIES,
}

TOOL_FACTORIES = {}
for _factories in DOMAINS.values():
    TOOL_FACTORIES.update(_factories)

# All developer-tool names this folder contributes (stable, sorted).
TOOL_NAMES = sorted(TOOL_FACTORIES.keys())
