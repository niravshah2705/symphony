"""Port of packages/shared/src/agent/fs-arg-normalizer.test.js."""

import pytest

from ai_fleet.agent.fs_arg_normalizer import (
    FILE_PATH_TOOLS,
    create_fs_arg_normalizer_middleware,
    normalize_fs_tool_args,
)


def test_remaps_path_to_file_path_for_read_file():
    args = {"path": "/repo/.agent-skills/linear/SKILL.md", "limit": 200}
    fixed = normalize_fs_tool_args("read_file", args)
    assert fixed == {"limit": 200, "file_path": "/repo/.agent-skills/linear/SKILL.md"}
    assert "path" not in fixed  # the mis-keyed alias is removed


def test_remaps_aliases_for_write_file_and_edit_file():
    assert normalize_fs_tool_args("write_file", {"filepath": "/a.txt", "content": "x"})["file_path"] == "/a.txt"
    assert (
        normalize_fs_tool_args("edit_file", {"file": "/b.txt", "old_string": "a", "new_string": "b"})["file_path"]
        == "/b.txt"
    )


def test_honors_alias_priority_prefers_path():
    fixed = normalize_fs_tool_args("read_file", {"path": "/win.txt", "filename": "/lose.txt"})
    assert fixed["file_path"] == "/win.txt"


def test_leaves_a_correct_call_untouched_same_reference():
    args = {"file_path": "/repo/x.js", "path": "/ignored"}
    assert normalize_fs_tool_args("read_file", args) is args


def test_does_not_rewrite_glob_grep_which_use_path():
    glob = {"pattern": "*.ts", "path": "/src"}
    assert normalize_fs_tool_args("glob", glob) is glob
    grep = {"pattern": "TODO", "path": "/src"}
    assert normalize_fs_tool_args("grep", grep) is grep


def test_no_op_when_no_alias_present_or_args_malformed():
    no_alias = {"offset": 0, "limit": 100}
    assert normalize_fs_tool_args("read_file", no_alias) is no_alias
    assert normalize_fs_tool_args("read_file", None) is None
    # Empty-string alias is not usable and must not overwrite file_path.
    empty = {"path": ""}
    assert normalize_fs_tool_args("read_file", empty) is empty


def test_unknown_tool_names_pass_through_unchanged():
    args = {"path": "/x"}
    assert normalize_fs_tool_args("web_search", args) is args


def test_file_path_tools_covers_exactly_the_file_path_tools():
    assert sorted(FILE_PATH_TOOLS) == ["edit_file", "read_file", "write_file"]


def test_middleware_repairs_the_tool_call_it_forwards():
    middleware = create_fs_arg_normalizer_middleware()
    assert middleware.name == "FsArgNormalizer"
    assert callable(getattr(middleware, "wrap_tool_call", None))

    forwarded = {}

    def handler(req):
        forwarded["req"] = req
        return {"ok": True}

    request = _FakeRequest({"name": "read_file", "id": "call_1", "args": {"path": "/p.md"}})
    result = middleware.wrap_tool_call(request, handler)

    assert result == {"ok": True}
    fwd = forwarded["req"]
    assert fwd.tool_call["args"]["file_path"] == "/p.md"
    assert "path" not in fwd.tool_call["args"]
    assert fwd.tool_call["id"] == "call_1"  # other tool-call fields are preserved
    # The original request object is not mutated.
    assert request.tool_call["args"]["path"] == "/p.md"


def test_middleware_forwards_a_correct_call_without_cloning():
    middleware = create_fs_arg_normalizer_middleware()
    forwarded = {}

    def handler(req):
        forwarded["req"] = req
        return "done"

    request = _FakeRequest({"name": "read_file", "args": {"file_path": "/ok.md"}})
    result = middleware.wrap_tool_call(request, handler)
    assert result == "done"
    assert forwarded["req"] is request  # unchanged calls are passed through as-is


class _FakeRequest:
    """Mimics langchain's ToolCallRequest: a `tool_call` dict + immutable override()."""

    def __init__(self, tool_call):
        self.tool_call = tool_call

    def override(self, **changes):
        new = _FakeRequest(self.tool_call)
        for key, value in changes.items():
            setattr(new, key, value)
        return new
