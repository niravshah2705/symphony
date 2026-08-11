"""The item universe per settings domain.

These are the concrete items a policy's include/exclude patterns match against
and the base set the cascade resolver narrows. They mirror the platform's
JS-side catalogs so the effective set means the same thing on both sides:

- harness — the agent-runtime ids (packages/shared/src/agent/runtimes.js RUNTIMES)
- tools   — the developer-tool registry domains (packages/shared/src/agent/tools/index.js DOMAINS)
- skills  — the vendored core-workflow skills (packages/shared/src/agent/skills/SKILLS.md)
- plugins — an operator-configurable list (SETTINGS_PLUGINS_CATALOG)
- hooks   — lifecycle-hook ids (config + catalog only; no execution engine yet —
            see settings-policy.js filterHooksByPolicy TODO)

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

# Lifecycle-hook ids, keyed to the points a future execution engine will fire
# them at. Config + catalog only today: the cascade governs which are allowed,
# but nothing runs them yet (see settings-policy.js filterHooksByPolicy TODO).
HOOKS: tuple[str, ...] = (
    "pre-plan",
    "post-plan",
    "pre-code",
    "post-code",
    "pre-pr",
    "post-merge",
)

# Task-model catalog ids — the preset ids in
# packages/shared/src/agent/llm-presets.json. The `models` domain stores allow/deny
# per model id (or a provider glob like ``claude-*``). ENFORCEMENT runs JS-side
# against the LIVE catalog (settings-policy.js), so this mirror only feeds the
# effective-set DISPLAY: a model missing here is still deny-able by a glob and still
# enforced at model-resolution time. Keep in sync when the catalog changes.
MODELS: tuple[str, ...] = (
    "ollama-gpt-oss-20b",
    "ollama-qwen3-coder-30b",
    "ollama-gpt-oss-120b",
    "lmstudio-gpt-oss-20b",
    "lmstudio-qwen3-coder-30b",
    "omlx-gpt-oss-20b",
    "omlx-qwen3-coder-next",
    "codex-gpt-5-6-sol",
    "codex-gpt-5-6-terra",
    "codex-gpt-5-6-luna",
    "codex-gpt-5-5",
    "codex-gpt-5-4",
    "codex-gpt-5-4-mini",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "huggingface-llama-3-3-70b",
    "huggingface-qwen2-5-coder-32b",
    "huggingface-kimi-k3",
    "huggingface-deepseek-v3",
    "huggingface-qwen2-5-72b",
    "antigravity-gemini-2-5-flash",
    "antigravity-gemini-2-5-pro",
)


def universe() -> dict[str, list[str]]:
    """The item universe for every domain. Plugins come from config."""
    return {
        "harness": list(HARNESS),
        "tools": list(TOOLS),
        "skills": list(SKILLS),
        "plugins": get_settings().plugins_catalog(),
        "hooks": list(HOOKS),
        "models": list(MODELS),
    }
