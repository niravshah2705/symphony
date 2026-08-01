"""Repair deep-agent filesystem tool calls whose path argument the model placed
under the wrong key (port of agent/fs-arg-normalizer.js).

The deepagents read_file/write_file/edit_file tools require a ``file_path``
argument, while their sibling glob/grep tools use ``path``. Smaller local models
routinely conflate the two and call read_file with ``path``. The tool's schema
then rejects the call, and in the deep-agent runtime that validation error aborts
the whole run instead of being handed back to the model to retry, so a single
mis-keyed argument fails the entire task.

This normalizes the call before it reaches the tool: for the file_path-taking
tools, if ``file_path`` is absent but a well-known alias (path/filepath/...)
carries the value, it is copied into ``file_path``. Correct calls are returned
untouched, and glob/grep (which legitimately use ``path``) are never rewritten.
"""

from __future__ import annotations

# Deepagents tools whose schema requires a `file_path` string argument.
FILE_PATH_TOOLS = frozenset({"read_file", "write_file", "edit_file"})

# Keys a model might use instead of `file_path`, checked in priority order.
FILE_PATH_ALIASES = ("path", "filepath", "filePath", "file", "filename")


def normalize_fs_tool_args(tool_name, args):
    """Return args with ``file_path`` filled in from a known alias when missing.

    Never mutates the input; returns the *same* object when no change is needed.
    """
    if tool_name not in FILE_PATH_TOOLS or not isinstance(args, dict):
        return args
    # A usable file_path is already present - leave the call exactly as-is.
    existing = args.get("file_path")
    if isinstance(existing, str) and existing:
        return args
    alias_key = None
    for key in FILE_PATH_ALIASES:
        value = args.get(key)
        if isinstance(value, str) and value:
            alias_key = key
            break
    if alias_key is None:
        return args
    alias_value = args[alias_key]
    rest = {k: v for k, v in args.items() if k != alias_key}
    return {**rest, "file_path": alias_value}


def create_fs_arg_normalizer_middleware():
    """Build a LangChain/deepagents AgentMiddleware that repairs mis-keyed
    filesystem tool calls. Append to the deep-agent middleware stack.

    Guarded import: LangChain's middleware base class is only present when the
    heavy agent deps are installed. The pure ``normalize_fs_tool_args`` above is
    the tested surface; this wires it into the runtime when available.
    """
    from langchain.agents.middleware import AgentMiddleware

    class FsArgNormalizer(AgentMiddleware):
        name = "FsArgNormalizer"

        def _repair(self, request):
            tool_call = getattr(request, "tool_call", None)
            if not tool_call:
                return request
            fixed = normalize_fs_tool_args(tool_call.get("name"), tool_call.get("args"))
            if fixed is tool_call.get("args"):
                return request
            return request.override(tool_call={**tool_call, "args": fixed})

        def wrap_tool_call(self, request, handler):
            return handler(self._repair(request))

        async def awrap_tool_call(self, request, handler):
            return await handler(self._repair(request))

    return FsArgNormalizer()
