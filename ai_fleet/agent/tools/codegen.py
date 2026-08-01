"""Codegen tool (port of agent/tools/codegen.js).

Generate client/server code from an OpenAPI spec by delegating to OpenAPI
Generator (the ``openapi-generator-cli`` binary if present, otherwise the
``@openapitools/openapi-generator-cli`` npx package). No templating logic is
re-implemented here. Requires a JDK (OpenAPI Generator runs on the JVM).
"""

from __future__ import annotations

import os
import re

from pydantic import BaseModel, Field

from ai_fleet.agent.tools.exec import (
    command_exists,
    define_tool,
    exec_tool,
    platform_cmd,
    resolve_workdir,
)

GENERATOR_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")


async def pick_openapi_generator():
    """Resolve the OpenAPI Generator invocation available on this host."""
    if await command_exists("openapi-generator-cli", "version"):
        return {"command": "openapi-generator-cli", "prefix": [], "hint": None}
    if await command_exists("openapi-generator", "version"):
        return {"command": "openapi-generator", "prefix": [], "hint": None}
    return {
        "command": platform_cmd("npx"),
        "prefix": ["--yes", "@openapitools/openapi-generator-cli"],
        "hint": "Install openapi-generator-cli, or allow npx to fetch @openapitools/openapi-generator-cli (needs a JDK).",
    }


class _OpenapiGenerateSchema(BaseModel):
    spec: str = Field(description="workspace-relative path to the OpenAPI spec (yaml/json)")
    generator: str = Field(description='OpenAPI Generator name, e.g. "typescript-axios", "python", "go"')
    output: str = Field(description="workspace-relative output directory")


async def _openapi_generate(input, ctx):
    spec_path = resolve_workdir(ctx, input.get("spec"))
    if not os.path.exists(spec_path):
        return f'❌ openapi_generate: spec not found at "{input.get("spec")}".'
    if not GENERATOR_RE.match(str(input.get("generator") or "")):
        raise Exception(f'invalid generator name: "{input.get("generator")}"')
    resolve_workdir(ctx, input.get("output"))  # assert output stays inside the workspace
    gen = await pick_openapi_generator()
    args = [*gen["prefix"], "generate", "-i", input["spec"], "-g", input["generator"], "-o", input["output"]]
    return await exec_tool(
        ctx=ctx,
        label=f"openapi generate ({input['generator']})",
        command=gen["command"],
        args=args,
        not_found_hint=gen.get("hint"),
    )


openapi_generate_tool = define_tool(
    {
        "name": "openapi_generate",
        "description": (
            "Generate client or server code from an OpenAPI/Swagger spec using OpenAPI Generator. Pass the spec path, "
            "a generator name (e.g. typescript-axios, python, go, spring), and an output directory. Requires a JDK."
        ),
        "schema": _OpenapiGenerateSchema,
    },
    _openapi_generate,
)

FACTORIES = {"openapi_generate": openapi_generate_tool}
