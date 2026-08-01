"""Port of packages/shared/src/agent/tools/registry.test.js."""

from __future__ import annotations

import os

from ai_fleet.agent import tools as registry
from ai_fleet.agent.tools.index import TOOL_FACTORIES, TOOL_NAMES
from ai_fleet.agent.workflows.coding import WORKFLOW as coding_workflow


def test_every_developer_tool_is_registered_in_the_framework_tool_registry():
    for name in TOOL_NAMES:
        assert registry.FACTORIES.get(name), f"registry is missing {name}"
    # The built-in tools remain registered alongside the new folder.
    assert registry.FACTORIES.get("web_search")
    assert registry.FACTORIES.get("linear_graphql")


def test_the_coding_workflow_wires_the_full_developer_toolbox():
    for name in TOOL_NAMES:
        assert name in coding_workflow["tools"], f"coding workflow is missing {name}"
    assert "playwright" in coding_workflow["mcp"]


def test_build_many_builds_known_tools_and_silently_drops_unknown_names():
    ctx = {"cwd": os.getcwd(), "step": lambda *a, **k: None}
    built = registry.build_many([*TOOL_NAMES, "no_such_tool"], ctx)
    assert len(built) == len(TOOL_NAMES)
    for t in built:
        assert t.name and t.description, "each built tool has a name and description"


def test_each_developer_tool_factory_produces_a_tool_whose_name_matches_its_registry_key():
    ctx = {"cwd": os.getcwd(), "step": lambda *a, **k: None}
    for name, factory in TOOL_FACTORIES.items():
        tool = factory(ctx)
        assert tool.name == name
