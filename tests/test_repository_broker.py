"""Port of packages/shared/src/agent/repository-broker.test.js.

The Node test injects a fake ``execFileImpl`` (fake git) and ``fetchImpl`` (fake
forge REST). Those seams are preserved here as Python async fakes. Three tests
exercise REAL git against a local bare remote; they are skipped when git is
unavailable.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from urllib.parse import parse_qs, urlsplit

import pytest

from ai_fleet.agent.repository_broker import (
    RepositoryBroker,
    RepositoryBrokerError,
    _default_exec_file,
    build_safe_agent_env,
    validate_repository,
)

SHA = "0123456789abcdef0123456789abcdef01234567"

_HAS_GIT = shutil.which("git") is not None
requires_git = pytest.mark.skipif(not _HAS_GIT, reason="git not available")


# --------------------------------------------------------------------------- #
# Fake forge response (mirrors the JS ``response()`` helper).
# --------------------------------------------------------------------------- #


class _Headers:
    def __init__(self, headers):
        self._headers = {str(k).lower(): v for k, v in (headers or {}).items()}

    def get(self, name):
        return self._headers.get(str(name).lower())


class _Response:
    def __init__(self, status, data, headers=None):
        self.status = status
        self.ok = 200 <= status < 300
        self._data = data
        self.headers = _Headers(headers)

    async def text(self):
        return "" if self._data is None else json.dumps(self._data)


def response(status, data, headers=None):
    return _Response(status, data, headers)


def _qparam(url, key):
    return parse_qs(urlsplit(url).query).get(key, [None])[0]


async def _unexpected_fetch(url, options):
    return response(500, {"message": "unexpected request"})


# --------------------------------------------------------------------------- #
# Fake git executor (mirrors the JS ``execFileImpl`` inside ``createScope``).
# --------------------------------------------------------------------------- #


def _make_exec_impl(git_calls, repository, opts):
    head_sha = opts.get("head_sha", SHA)
    state = {"current": "task-123"}
    local_branches = {"task-123"}
    remote_branches = set(opts.get("remote_branch_names", []))
    heads = {"task-123": head_sha}
    heads.update(opts.get("branch_shas", {}))
    reported_remote = opts.get("reported_remote")
    status_output = opts.get("status_output", "")
    tree_matches_base = opts.get("tree_matches_base", True)
    index_flags = opts.get("index_flags", "")
    fsmonitor_flags = opts.get("fsmonitor_flags", "")
    dangerous_config = opts.get("dangerous_config", "")

    async def exec_impl(command, args, options):
        args = list(args)
        git_calls.append({"command": command, "args": list(args), "options": options})
        joined = "\u0000".join(str(a) for a in args)
        if "remote\u0000get-url\u0000origin" in joined:
            return {"stdout": reported_remote or repository["https"]}
        if "config\u0000--local\u0000--get-regexp" in joined:
            if dangerous_config:
                return {"stdout": dangerous_config}
            raise Exception("not found")
        if "branch\u0000--show-current" in joined:
            return {"stdout": state["current"]}
        if "checkout" in args:
            ci = args.index("checkout")
            if ci + 1 < len(args) and args[ci + 1] == "-b":
                previous_sha = heads.get(state["current"], head_sha)
                state["current"] = args[ci + 2]
                local_branches.add(state["current"])
                heads.setdefault(state["current"], previous_sha)
                return {"stdout": ""}
            state["current"] = args[ci + 1]
            return {"stdout": ""}
        if "show-ref" in args:
            ref = args[-1]
            if ref.startswith("refs/heads/") and ref[len("refs/heads/") :] in local_branches:
                return {"stdout": ""}
            if ref.startswith("refs/remotes/origin/") and ref[len("refs/remotes/origin/") :] in remote_branches:
                return {"stdout": ""}
            raise Exception("not found")
        if "rev-parse\u0000HEAD" in joined:
            return {"stdout": heads.get(state["current"], head_sha)}
        if "rev-parse\u0000refs/heads/" in joined or "rev-parse\u0000refs/remotes/origin/" in joined:
            ref = args[-1]
            branch = re.sub(r"^refs/(?:heads|remotes/origin)/", "", ref)
            return {"stdout": heads.get(branch, head_sha)}
        if "ls-files\u0000-v" in joined:
            return {"stdout": index_flags}
        if "ls-files\u0000-f" in joined:
            return {"stdout": fsmonitor_flags}
        if "status\u0000--porcelain" in joined:
            return {"stdout": status_output() if callable(status_output) else status_output}
        if "diff\u0000--quiet" in joined:
            if tree_matches_base:
                return {"stdout": ""}
            raise Exception("trees differ")
        if "push" in args:
            refspec = str(args[-1])
            match = re.match(r"^refs/heads/([^:]+):refs/heads/([^:]+)$", refspec)
            if match and match.group(1) == match.group(2):
                remote_branches.add(match.group(1))
        return {"stdout": ""}

    return exec_impl


class _Scope:
    def __init__(self, broker, git_calls, repository, token, work_dir):
        self.broker = broker
        self.git_calls = git_calls
        self.repository = repository
        self.token = token
        self.work_dir = work_dir


@pytest.fixture
def make_scope():
    cleanups = []

    def factory(**opts):
        provider = opts.get("provider", "github")
        token = opts.get("token", "stored-secret-token")
        root = tempfile.mkdtemp(prefix="repository-broker-test-")
        work_dir = os.path.join(root, "ticket")
        os.makedirs(os.path.join(work_dir, ".git"), exist_ok=True)
        if provider == "github":
            repository = {
                "provider": provider,
                "owner": "acme",
                "name": "widgets",
                "fullName": "acme/widgets",
                "https": "https://github.com/acme/widgets.git",
            }
        else:
            repository = {
                "provider": provider,
                "owner": "acme/platform",
                "name": "widgets",
                "fullName": "acme/platform/widgets",
                "https": "https://gitlab.com/acme/platform/widgets.git",
            }
        with open(os.path.join(work_dir, ".git", "config"), "w", encoding="utf-8") as handle:
            handle.write(f'[remote "origin"]\n\turl = {repository["https"]}\n')

        git_calls = []
        exec_impl = _make_exec_impl(git_calls, repository, opts)
        fetch_impl = opts.get("fetch_impl") or _unexpected_fetch

        broker = RepositoryBroker(
            provider=provider,
            repository=repository,
            token=token,
            workspace_root=root,
            work_dir=work_dir,
            branch="task-123",
            label="techsymphony",
            fetch_impl=fetch_impl,
            exec_file_impl=exec_impl,
        )
        broker.baseBranch = "main"

        def cleanup():
            broker.dispose()
            shutil.rmtree(root, ignore_errors=True)

        cleanups.append(cleanup)
        return _Scope(broker, git_calls, repository, token, work_dir)

    yield factory
    for fn in reversed(cleanups):
        try:
            fn()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Pure-function tests.
# --------------------------------------------------------------------------- #


def test_safe_shell_environment_allowlists_and_drops_secrets():
    root = tempfile.mkdtemp(prefix="safe-agent-env-")
    try:
        env = build_safe_agent_env(
            {
                "PATH": "/usr/bin:/bin",
                "LANG": "en_US.UTF-8",
                "HOME": "/Users/operator",
                "GH_TOKEN": "github-secret",
                "GITLAB_TOKEN": "gitlab-secret",
                "TECHSYMPHONY_BROKER_GIT_TOKEN": "broker-secret",
                "LINEAR_API_KEY": "linear-secret",
                "AWS_SECRET_ACCESS_KEY": "cloud-secret",
                "OTHER": "not-allowlisted",
            },
            root,
        )
        assert env["PATH"] == "/usr/bin:/bin"
        assert env["LANG"] == "en_US.UTF-8"
        assert env["GIT_TERMINAL_PROMPT"] == "0"
        assert env["HOME"] != "/Users/operator"
        assert env["HOME"].startswith(
            os.path.join(tempfile.gettempdir(), "techsymphony-agent-home")
        )
        for key in [
            "GH_TOKEN",
            "GITLAB_TOKEN",
            "TECHSYMPHONY_BROKER_GIT_TOKEN",
            "LINEAR_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "OTHER",
        ]:
            assert env.get(key) is None, f"{key} must not reach LocalShellBackend"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_repository_scope_rejects_cross_provider_hosts_and_nested_github():
    with pytest.raises(RepositoryBrokerError, match="outside the selected provider host"):
        validate_repository(
            {
                "provider": "github",
                "owner": "acme",
                "name": "widgets",
                "fullName": "acme/widgets",
                "https": "https://gitlab.com/acme/widgets.git",
            },
            "github",
        )
    with pytest.raises(RepositoryBrokerError, match="namespace is invalid"):
        validate_repository(
            {
                "provider": "github",
                "owner": "acme/platform",
                "name": "widgets",
                "fullName": "acme/platform/widgets",
                "https": "https://github.com/acme/platform/widgets.git",
            },
            "github",
        )
    with pytest.raises(RepositoryBrokerError, match="namespace is invalid"):
        validate_repository(
            {
                "provider": "gitlab",
                "owner": "acme",
                "name": "widgets",
                "fullName": "another/widgets",
                "https": "https://gitlab.com/acme/widgets.git",
            },
            "gitlab",
        )


# --------------------------------------------------------------------------- #
# Mocked-git broker tests.
# --------------------------------------------------------------------------- #


async def test_push_fixes_refspec_and_keeps_token_out_of_argv_and_config(make_scope):
    scope = make_scope()
    result = await scope.broker.execute({"action": "push"})

    assert result["pushed"] is True
    assert result["branch"] == "task-123"
    push = next((c for c in scope.git_calls if "push" in c["args"]), None)
    assert push, "expected an authenticated staging push"
    assert "refs/heads/task-123:refs/heads/task-123" in push["args"]
    assert not any("--force" in str(a) for a in push["args"])
    assert not any(scope.token in str(a) for a in push["args"])
    assert scope.token in push["options"]["env"].values()
    with open(os.path.join(scope.work_dir, ".git", "config"), encoding="utf-8") as handle:
        assert "stored-secret-token" not in handle.read()
    serialized = json.dumps(
        [{"command": c["command"], "args": c["args"]} for c in scope.git_calls]
    )
    assert "stored-secret-token" not in serialized
    status = next(c for c in scope.git_calls if "status" in c["args"])
    assert "status.showUntrackedFiles=all" in status["args"]
    assert "--untracked-files=all" in status["args"]
    assert "--ignore-submodules=none" in status["args"]


async def test_clean_workspace_checks_fail_closed(make_scope):
    hidden = make_scope(index_flags="S src/hidden.js")
    with pytest.raises(RepositoryBrokerError) as ei:
        await hidden.broker.execute({"action": "push"})
    assert ei.value.code == "unsafe_index_flags"

    fsmonitor = make_scope(fsmonitor_flags="h src/cached.js")
    with pytest.raises(RepositoryBrokerError) as ei:
        await fsmonitor.broker.execute({"action": "push"})
    assert ei.value.code == "unsafe_index_flags"

    configured = make_scope(dangerous_config="status.showuntrackedfiles no")
    with pytest.raises(RepositoryBrokerError) as ei:
        await configured.broker.execute({"action": "push"})
    assert ei.value.code == "unsafe_git_config"

    excluded = make_scope()
    os.makedirs(os.path.join(excluded.work_dir, ".git", "info"), exist_ok=True)
    with open(
        os.path.join(excluded.work_dir, ".git", "info", "exclude"), "w", encoding="utf-8"
    ) as handle:
        handle.write("private-output.log\n")
    with pytest.raises(RepositoryBrokerError) as ei:
        await excluded.broker.execute({"action": "push"})
    assert ei.value.code == "unsafe_git_config"


async def test_rejects_reused_checkout_with_different_origin(make_scope):
    scope = make_scope(reported_remote="https://github.com/other/project.git")
    with pytest.raises(RepositoryBrokerError) as ei:
        await scope.broker.execute({"action": "push"})
    assert ei.value.code == "origin_mismatch"


async def test_github_review_creation_uses_official_api(make_scope):
    requests = []

    async def fetch_impl(url, options):
        requests.append({"url": url, "options": options})
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [])
        if options["method"] == "POST" and url.endswith("/pulls"):
            body = json.loads(options["body"])
            assert {
                "head": body["head"],
                "base": body["base"],
                "draft": body["draft"],
            } == {"head": "task-123", "base": "main", "draft": False}
            return response(
                201,
                {
                    "number": 17,
                    "html_url": "https://github.com/acme/widgets/pull/17",
                    "state": "open",
                    "title": body["title"],
                    "head": {"ref": "task-123", "sha": SHA},
                    "base": {"ref": "main"},
                },
            )
        if options["method"] == "POST" and url.endswith("/issues/17/labels"):
            return response(200, {})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    tool = scope.broker.create_tool()
    output = json.loads(
        await tool.ainvoke({"action": "open_review", "title": "Fix widgets", "body": "Validated."})
    )

    assert output["ok"] is True
    assert output["url"] == "https://github.com/acme/widgets/pull/17"
    assert all(r["url"].startswith("https://api.github.com/repos/acme/widgets/") for r in requests)
    assert all(r["options"]["redirect"] == "error" for r in requests)
    assert all(
        r["options"]["headers"]["Authorization"] == f"Bearer {scope.token}" for r in requests
    )
    assert all(
        r["options"]["headers"]["X-GitHub-Api-Version"] == "2022-11-28" for r in requests
    )
    with pytest.raises(Exception):
        await tool.ainvoke({"action": "push", "branch": "another-branch"})


async def test_existing_github_review_reused_after_reapplying_label(make_scope):
    label_calls = {"count": 0}
    existing = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "open",
        "title": "Fix widgets",
        "labels": [],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [existing])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, existing)
        if options["method"] == "POST" and url.endswith("/issues/17/labels"):
            label_calls["count"] += 1
            return response(200, {"labels": [{"name": "techsymphony"}]})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    result = await scope.broker.execute({"action": "open_review", "title": "Fix widgets"})

    assert result["reused"] is True
    assert result["labelApplied"] is True
    assert label_calls["count"] == 1


async def test_terminal_review_recovered_on_deterministic_retry_branch(make_scope):
    closed = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "closed",
        "title": "Old attempt",
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    created_heads = []

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            head = _qparam(url, "head")
            return response(200, [closed] if head == "acme:task-123" else [])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, {**closed, "merged": False})
        if options["method"] == "POST" and url.endswith("/pulls"):
            body = json.loads(options["body"])
            created_heads.append(body["head"])
            return response(
                201,
                {
                    "number": 18,
                    "html_url": "https://github.com/acme/widgets/pull/18",
                    "state": "open",
                    "title": body["title"],
                    "head": {"ref": body["head"], "sha": SHA},
                    "base": {"ref": body["base"]},
                },
            )
        if options["method"] == "POST" and url.endswith("/issues/18/labels"):
            return response(200, {})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    result = await scope.broker.execute({"action": "open_review", "title": "Retry widgets"})

    assert result["state"] == "open"
    assert created_heads == ["task-123-retry-17"]
    assert scope.broker.publicInfo()["branch"] == "task-123-retry-17"
    checkout = next(
        c
        for c in scope.git_calls
        if "checkout" in c["args"]
        and c["args"].index("checkout") + 1 < len(c["args"])
        and c["args"][c["args"].index("checkout") + 1] == "-b"
    )
    ci = checkout["args"].index("checkout")
    assert checkout["args"][ci + 2] == "task-123-retry-17"
    push = next(
        (c for c in scope.git_calls if "refs/heads/task-123-retry-17:refs/heads/task-123-retry-17" in c["args"]),
        None,
    )
    assert push, "the derived retry branch must be published with a fixed non-force refspec"
    assert not any(any("--force" in str(a) for a in c["args"]) for c in scope.git_calls)


async def test_fresh_run_resumes_matching_open_retry_review(make_scope):
    retry_sha = "89abcdef0123456789abcdef0123456789abcdef"
    closed = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "closed",
        "title": "Old attempt",
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    retry = {
        "number": 18,
        "html_url": "https://github.com/acme/widgets/pull/18",
        "state": "open",
        "title": "Retry widgets",
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123-retry-17", "sha": retry_sha},
        "base": {"ref": "main"},
    }
    create_calls = {"count": 0}

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            head = _qparam(url, "head")
            if head == "acme:task-123":
                return response(200, [closed])
            if head == "acme:task-123-retry-17":
                return response(200, [retry])
            return response(200, [])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, {**closed, "merged": False})
        if options["method"] == "GET" and url.endswith("/pulls/18"):
            return response(200, retry)
        if options["method"] == "POST" and url.endswith("/issues/18/labels"):
            return response(200, {})
        if options["method"] == "POST" and url.endswith("/pulls"):
            create_calls["count"] += 1
            return response(500, {"message": "duplicate review must not be created"})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(
        fetch_impl=fetch_impl,
        remote_branch_names=["task-123-retry-17"],
        branch_shas={"task-123-retry-17": retry_sha},
    )
    result = await scope.broker.execute({"action": "open_review", "title": "Retry widgets"})

    assert result["reused"] is True
    assert result["resumed"] is True
    assert result["id"] == 18
    assert result["branch"] == "task-123-retry-17"
    assert scope.broker.publicInfo()["branch"] == "task-123-retry-17"
    assert create_calls["count"] == 0


async def test_new_committed_work_preserved_on_fresh_retry(make_scope):
    new_sha = "abcdef0123456789abcdef0123456789abcdef01"
    retry_sha = "89abcdef0123456789abcdef0123456789abcdef"
    closed = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "closed",
        "title": "Old attempt",
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    retry = {
        "number": 18,
        "html_url": "https://github.com/acme/widgets/pull/18",
        "state": "open",
        "title": "Existing retry",
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123-retry-17", "sha": retry_sha},
        "base": {"ref": "main"},
    }
    created_heads = []

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            head = _qparam(url, "head")
            if head == "acme:task-123":
                return response(200, [closed])
            if head == "acme:task-123-retry-17":
                return response(200, [retry])
            return response(200, [])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, {**closed, "merged": False})
        if options["method"] == "GET" and url.endswith("/pulls/18"):
            return response(200, retry)
        if options["method"] == "POST" and url.endswith("/pulls"):
            body = json.loads(options["body"])
            created_heads.append(body["head"])
            return response(
                201,
                {
                    "number": 19,
                    "html_url": "https://github.com/acme/widgets/pull/19",
                    "state": "open",
                    "title": body["title"],
                    "head": {"ref": body["head"], "sha": new_sha},
                    "base": {"ref": body["base"]},
                },
            )
        if options["method"] == "POST" and url.endswith("/issues/19/labels"):
            return response(200, {})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(
        fetch_impl=fetch_impl,
        head_sha=new_sha,
        tree_matches_base=False,
        remote_branch_names=["task-123-retry-17"],
        branch_shas={"task-123-retry-17": retry_sha},
    )
    result = await scope.broker.execute({"action": "open_review", "title": "Preserve new work"})

    assert result["reused"] is False
    assert created_heads == ["task-123-retry-17-2"]
    assert result["branch"] == "task-123-retry-17-2"
    assert result["headSha"] == new_sha


async def test_already_merged_review_reused_without_duplicate(make_scope):
    listed = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "closed",
        "title": "Completed widgets",
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    create_calls = {"count": 0}

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [listed])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, {**listed, "merged": True, "merged_at": "2026-07-16T08:00:00Z"})
        if options["method"] == "POST" and url.endswith("/issues/17/labels"):
            return response(200, {})
        if options["method"] == "POST" and url.endswith("/pulls"):
            create_calls["count"] += 1
            return response(500, {"message": "duplicate review must not be created"})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    result = await scope.broker.execute({"action": "open_review", "title": "Completed widgets"})

    assert result["state"] == "merged"
    assert result["reused"] is True
    assert result["alreadyMerged"] is True
    assert result["url"] == listed["html_url"]
    assert create_calls["count"] == 0
    assert scope.broker.publicInfo()["branch"] == "task-123"
    assert not any("checkout" in c["args"] for c in scope.git_calls)


async def test_already_merged_review_with_new_work_rotates_to_retry(make_scope):
    new_sha = "abcdef0123456789abcdef0123456789abcdef01"
    merged = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "closed",
        "merged": True,
        "title": "Completed widgets",
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    created_heads = []

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            head = _qparam(url, "head")
            return response(200, [merged] if head == "acme:task-123" else [])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, merged)
        if options["method"] == "POST" and url.endswith("/pulls"):
            body = json.loads(options["body"])
            created_heads.append(body["head"])
            return response(
                201,
                {
                    "number": 18,
                    "html_url": "https://github.com/acme/widgets/pull/18",
                    "state": "open",
                    "title": body["title"],
                    "head": {"ref": body["head"], "sha": new_sha},
                    "base": {"ref": body["base"]},
                },
            )
        if options["method"] == "POST" and url.endswith("/issues/18/labels"):
            return response(200, {})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl, head_sha=new_sha, tree_matches_base=False)
    result = await scope.broker.execute({"action": "open_review", "title": "More widget work"})

    assert result["state"] == "open"
    assert created_heads == ["task-123-retry-17"]
    assert scope.broker.publicInfo()["branch"] == "task-123-retry-17"


async def test_review_status_exposes_feedback_through_cursor_windows(make_scope):
    review = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "open",
        "title": "Fix widgets",
        "mergeable": True,
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    comments = [
        {
            "id": index + 1,
            "body": f"feedback {index + 1}",
            "user": {"login": "reviewer"},
            "html_url": f"https://github.com/comment/{index + 1}",
        }
        for index in range(25)
    ]

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [review])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, review)
        if options["method"] == "GET" and "/check-runs?" in url:
            return response(200, {"total_count": 0, "check_runs": []})
        if options["method"] == "GET" and "/status?" in url:
            return response(200, {"total_count": 0, "state": "success", "statuses": []})
        if options["method"] == "GET" and "/issues/17/comments?" in url:
            return response(200, comments)
        if options["method"] == "GET" and re.search(r"/pulls/17/(reviews|comments)\?", url):
            return response(200, [])
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    first = await scope.broker.execute({"action": "review_status", "cursor": 0})
    second = await scope.broker.execute(
        {"action": "review_status", "cursor": first["nextFeedbackCursor"]}
    )

    assert first["feedbackTotal"] == 25
    assert len(first["feedback"]) == 20
    assert first["nextFeedbackCursor"] == 20
    assert first["feedbackReadComplete"] is False
    assert len(second["feedback"]) == 5
    assert second["nextFeedbackCursor"] is None
    assert second["feedbackReadComplete"] is True
    assert second["feedback"][0]["body"] == "feedback 21"


async def test_github_merge_requires_every_feedback_window_consumed(make_scope):
    review = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "open",
        "title": "Fix widgets",
        "mergeable": True,
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    comments = [
        {"id": index + 1, "body": f"feedback {index + 1}", "user": {"login": "reviewer"}}
        for index in range(25)
    ]
    merge_calls = {"count": 0}

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [review])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, review)
        if options["method"] == "GET" and "/check-runs?" in url:
            return response(200, {"total_count": 0, "check_runs": []})
        if options["method"] == "GET" and "/status?" in url:
            return response(200, {"total_count": 0, "state": "success", "statuses": []})
        if options["method"] == "GET" and "/issues/17/comments?" in url:
            return response(200, comments)
        if options["method"] == "GET" and re.search(r"/pulls/17/(reviews|comments)\?", url):
            return response(200, [])
        if options["method"] == "PUT" and url.endswith("/pulls/17/merge"):
            merge_calls["count"] += 1
            return response(200, {"merged": True, "sha": SHA, "message": "merged"})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    out_of_order = await scope.broker.execute({"action": "review_status", "cursor": 20})
    assert out_of_order["feedbackReadComplete"] is False
    assert out_of_order["expectedFeedbackCursor"] == 0

    with pytest.raises(RepositoryBrokerError) as ei:
        await scope.broker.execute({"action": "merge_review"})
    assert ei.value.code == "feedback_unread"
    assert merge_calls["count"] == 0

    first = await scope.broker.execute({"action": "review_status", "cursor": 0})
    assert first["feedbackReadComplete"] is False
    assert first["expectedFeedbackCursor"] == 20
    with pytest.raises(RepositoryBrokerError) as ei:
        await scope.broker.execute({"action": "merge_review"})
    assert ei.value.code == "feedback_unread"
    assert merge_calls["count"] == 0

    final = await scope.broker.execute(
        {"action": "review_status", "cursor": first["nextFeedbackCursor"]}
    )
    assert final["feedbackReadComplete"] is True
    merged = await scope.broker.execute({"action": "merge_review"})
    assert merged["merged"] is True
    assert merge_calls["count"] == 1


async def test_github_merge_requires_explicit_status_read_for_one_page(make_scope):
    review = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "open",
        "title": "Fix widgets",
        "mergeable": True,
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    comment = {"id": 1, "body": "Please verify the edge case.", "user": {"login": "reviewer"}}
    merge_calls = {"count": 0}

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [review])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, review)
        if options["method"] == "GET" and "/check-runs?" in url:
            return response(200, {"total_count": 0, "check_runs": []})
        if options["method"] == "GET" and "/status?" in url:
            return response(200, {"total_count": 0, "state": "success", "statuses": []})
        if options["method"] == "GET" and "/issues/17/comments?" in url:
            return response(200, [comment])
        if options["method"] == "GET" and re.search(r"/pulls/17/(reviews|comments)\?", url):
            return response(200, [])
        if options["method"] == "PUT" and url.endswith("/pulls/17/merge"):
            merge_calls["count"] += 1
            return response(200, {"merged": True, "sha": SHA, "message": "merged"})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    with pytest.raises(RepositoryBrokerError) as ei:
        await scope.broker.execute({"action": "merge_review"})
    assert ei.value.code == "feedback_unread"
    assert merge_calls["count"] == 0

    status = await scope.broker.execute({"action": "review_status", "cursor": 0})
    assert status["feedbackReadComplete"] is True
    merged = await scope.broker.execute({"action": "merge_review"})
    assert merged["merged"] is True
    assert merge_calls["count"] == 1


async def test_merge_fails_closed_when_review_retargeted_outside_base(make_scope):
    listed = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "open",
        "title": "Fix widgets",
        "mergeable": True,
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    merge_called = {"value": False}

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [listed])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, {**listed, "base": {"ref": "release"}})
        if options["method"] == "PUT":
            merge_called["value"] = True
            return response(200, {"merged": True, "sha": SHA})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    with pytest.raises(RepositoryBrokerError) as ei:
        await scope.broker.execute({"action": "merge_review"})
    assert ei.value.code == "review_scope"
    assert merge_called["value"] is False


async def test_merge_blocked_when_workspace_dirty(make_scope):
    review = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "open",
        "title": "Fix widgets",
        "mergeable": True,
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    merge_called = {"value": False}

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [review])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, review)
        if options["method"] == "GET" and "/check-runs?" in url:
            return response(200, {"total_count": 0, "check_runs": []})
        if options["method"] == "GET" and "/status?" in url:
            return response(200, {"total_count": 0, "state": "success", "statuses": []})
        if options["method"] == "GET" and re.search(r"/(reviews|comments)\?", url):
            return response(200, [])
        if options["method"] == "PUT":
            merge_called["value"] = True
            return response(200, {"merged": True, "sha": SHA})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl, status_output=" M src/index.js")
    with pytest.raises(RepositoryBrokerError) as ei:
        await scope.broker.execute({"action": "merge_review"})
    assert ei.value.code == "workspace_dirty"
    assert merge_called["value"] is False


async def test_github_merge_blocks_startup_failed_and_truncated_checks(make_scope):
    review = {
        "number": 17,
        "html_url": "https://github.com/acme/widgets/pull/17",
        "state": "open",
        "title": "Fix widgets",
        "mergeable": True,
        "labels": [{"name": "techsymphony"}],
        "head": {"ref": "task-123", "sha": SHA},
        "base": {"ref": "main"},
    }
    merge_called = {"value": False}

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/pulls?" in url:
            return response(200, [review])
        if options["method"] == "GET" and url.endswith("/pulls/17"):
            return response(200, review)
        if options["method"] == "GET" and "/check-runs?" in url:
            return response(
                200,
                {
                    "total_count": 101,
                    "check_runs": [
                        {"name": "build", "status": "completed", "conclusion": "startup_failure"}
                    ],
                },
            )
        if options["method"] == "GET" and "/status?" in url:
            return response(200, {"total_count": 0, "state": "success", "statuses": []})
        if options["method"] == "GET" and re.search(r"/(reviews|comments)\?", url):
            return response(200, [])
        if options["method"] == "PUT":
            merge_called["value"] = True
            return response(200, {"merged": True, "sha": SHA})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(fetch_impl=fetch_impl)
    with pytest.raises(RepositoryBrokerError) as ei:
        await scope.broker.execute({"action": "merge_review"})
    assert ei.value.code == "review_blocked"
    assert merge_called["value"] is False


async def test_gitlab_status_and_merge_use_project_scoped_apis(make_scope):
    requests = []
    mr = {
        "iid": 9,
        "web_url": "https://gitlab.com/acme/platform/widgets/-/merge_requests/9",
        "state": "opened",
        "title": "Fix widgets",
        "source_branch": "task-123",
        "target_branch": "main",
        "sha": SHA,
        "detailed_merge_status": "mergeable",
        "labels": ["techsymphony"],
        "blocking_discussions_resolved": True,
        "head_pipeline": {"id": 4, "sha": SHA, "status": "success", "web_url": "https://gitlab.com/pipeline/4"},
    }

    async def fetch_impl(url, options):
        requests.append({"url": url, "options": options})
        if options["method"] == "GET" and "/merge_requests?" in url:
            return response(200, [mr])
        if options["method"] == "GET" and "/merge_requests/9?" in url:
            return response(200, mr)
        if options["method"] == "GET" and "/merge_requests/9/pipelines?" in url:
            return response(200, [mr["head_pipeline"]])
        if options["method"] == "GET" and "/merge_requests/9/discussions?" in url:
            return response(200, [])
        if options["method"] == "PUT" and url.endswith("/merge_requests/9/merge"):
            body = json.loads(options["body"])
            assert {
                "sha": body["sha"],
                "squash": body["squash"],
                "should_remove_source_branch": body["should_remove_source_branch"],
            } == {"sha": SHA, "squash": True, "should_remove_source_branch": True}
            return response(200, {**mr, "state": "merged", "squash_commit_sha": SHA})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(provider="gitlab", fetch_impl=fetch_impl)
    output = await scope.broker.execute({"action": "merge_review"})

    assert output["merged"] is True
    assert output["provider"] == "gitlab"
    assert all(
        r["url"].startswith("https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/")
        for r in requests
    )
    assert all(r["options"]["headers"]["PRIVATE-TOKEN"] == scope.token for r in requests)
    assert all(r["options"]["redirect"] == "error" for r in requests)
    assert not any(re.search(r"api\.github|/gh\b|/glab\b", r["url"]) for r in requests)


async def test_gitlab_merge_blocks_manual_or_stale_head_pipelines(make_scope):
    stale_sha = "abcdef0123456789abcdef0123456789abcdef01"
    mr = {
        "iid": 9,
        "web_url": "https://gitlab.com/acme/platform/widgets/-/merge_requests/9",
        "state": "opened",
        "title": "Fix widgets",
        "source_branch": "task-123",
        "target_branch": "main",
        "sha": SHA,
        "detailed_merge_status": "mergeable",
        "labels": ["techsymphony"],
        "blocking_discussions_resolved": True,
        "head_pipeline": {"id": 3, "sha": stale_sha, "status": "success"},
    }
    merge_called = {"value": False}

    async def fetch_impl(url, options):
        if options["method"] == "GET" and "/merge_requests?" in url:
            return response(200, [mr])
        if options["method"] == "GET" and "/merge_requests/9?" in url:
            return response(200, mr)
        if options["method"] == "GET" and "/pipelines?" in url:
            return response(200, [{"id": 4, "sha": SHA, "status": "manual"}, mr["head_pipeline"]])
        if options["method"] == "GET" and "/discussions?" in url:
            return response(200, [])
        if options["method"] == "PUT":
            merge_called["value"] = True
            return response(200, {**mr, "state": "merged"})
        return response(500, {"message": "unexpected request"})

    scope = make_scope(provider="gitlab", fetch_impl=fetch_impl)
    with pytest.raises(RepositoryBrokerError) as ei:
        await scope.broker.execute({"action": "merge_review"})
    assert ei.value.code == "review_blocked"
    assert merge_called["value"] is False


async def test_tool_facing_provider_errors_are_redacted(make_scope):
    token = "token-that-must-not-leak"

    async def fetch_impl(url, options):
        return response(401, {"message": f"bad credential {token}"})

    scope = make_scope(token=token, fetch_impl=fetch_impl)
    output = await scope.broker.create_tool().ainvoke({"action": "review_status"})

    assert token not in output
    assert "***" in output
    assert scope.broker.availabilityError().code == "provider_error"
    assert token not in scope.broker.availabilityError().message


async def test_ordinary_review_workflow_errors_are_not_outages(make_scope):
    async def fetch_impl(url, options):
        return response(200, [])

    scope = make_scope(fetch_impl=fetch_impl)
    output = await scope.broker.create_tool().ainvoke({"action": "merge_review"})

    assert "review_missing" in output
    assert scope.broker.availabilityError() is None


# --------------------------------------------------------------------------- #
# Real-git integration tests (skipped when git is unavailable).
# --------------------------------------------------------------------------- #


def _git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout


def _redirect_exec(remote, redirect_push=False):
    async def exec_impl(command, input_args, options):
        args = list(input_args)
        private_bare = any(str(a).startswith("--git-dir=") for a in args)
        should_redirect = "ls-remote" in args or (
            private_bare
            and ("fetch" in args or (redirect_push and "push" in args))
        )
        if should_redirect and "origin" in args:
            args[args.index("origin")] = remote
        return await _default_exec_file(command, args, options)

    return exec_impl


@requires_git
async def test_prepared_checkout_excludes_framework_skills():
    root = tempfile.mkdtemp(prefix="repository-broker-prepare-")
    try:
        seed = os.path.join(root, "seed")
        remote = os.path.join(root, "remote.git")
        workspace_root = os.path.join(root, "workspaces")
        work_dir = os.path.join(workspace_root, "ticket")
        os.makedirs(seed, exist_ok=True)
        _git(seed, "init", "-b", "main")
        _git(seed, "config", "user.name", "Test")
        _git(seed, "config", "user.email", "test@example.com")
        with open(os.path.join(seed, "README.md"), "w") as handle:
            handle.write("# fixture\n")
        _git(seed, "add", "README.md")
        _git(seed, "commit", "-m", "fixture")
        _git(seed, "checkout", "-b", "task-123")
        with open(os.path.join(seed, "remote-work.txt"), "w") as handle:
            handle.write("published by an earlier run\n")
        _git(seed, "add", "remote-work.txt")
        _git(seed, "commit", "-m", "remote task work")
        _git(seed, "checkout", "main")
        _git(root, "clone", "--bare", seed, remote)

        broker = RepositoryBroker(
            provider="github",
            repository={
                "provider": "github",
                "owner": "acme",
                "name": "widgets",
                "fullName": "acme/widgets",
                "https": "https://github.com/acme/widgets.git",
            },
            workspace_root=workspace_root,
            work_dir=work_dir,
            branch="task-123",
            exec_file_impl=_redirect_exec(remote),
        )
        try:
            await broker.prepare()
            with open(os.path.join(work_dir, "remote-work.txt")) as handle:
                assert handle.read() == "published by an earlier run\n"
            os.makedirs(os.path.join(work_dir, ".agent-skills"), exist_ok=True)
            with open(os.path.join(work_dir, ".agent-skills", "SKILL.md"), "w") as handle:
                handle.write("framework data\n")
            assert _git(work_dir, "status", "--porcelain") == ""
            with open(os.path.join(work_dir, "project-change.txt"), "w") as handle:
                handle.write("must remain visible\n")
            assert "project-change.txt" in _git(work_dir, "status", "--porcelain")
        finally:
            broker.dispose()
    finally:
        shutil.rmtree(root, ignore_errors=True)


@requires_git
async def test_empty_remote_is_initialized_with_base_branch():
    root = tempfile.mkdtemp(prefix="repository-broker-empty-")
    try:
        remote = os.path.join(root, "remote.git")
        workspace_root = os.path.join(root, "workspaces")
        work_dir = os.path.join(workspace_root, "ticket")
        _git(root, "init", "--bare", "-b", "main", remote)

        broker = RepositoryBroker(
            provider="github",
            repository={
                "provider": "github",
                "owner": "acme",
                "name": "widgets",
                "fullName": "acme/widgets",
                "https": "https://github.com/acme/widgets.git",
            },
            token="seed-token",
            workspace_root=workspace_root,
            work_dir=work_dir,
            branch="task-123",
            exec_file_impl=_redirect_exec(remote, redirect_push=True),
        )
        try:
            info = await broker.prepare()
            assert info["branch"] == "task-123"
            assert info["baseBranch"] == "main"
            heads = _git(root, "ls-remote", "--heads", remote)
            assert re.search(r"refs/heads/main$", heads, flags=re.MULTILINE)
            assert _git(work_dir, "branch", "--show-current").strip() == "task-123"
            assert _git(work_dir, "status", "--porcelain") == ""
        finally:
            broker.dispose()
    finally:
        shutil.rmtree(root, ignore_errors=True)


@requires_git
async def test_dirty_workspace_is_reset_instead_of_bricking_next_task():
    root = tempfile.mkdtemp(prefix="repository-broker-dirty-")
    try:
        seed = os.path.join(root, "seed")
        remote = os.path.join(root, "remote.git")
        workspace_root = os.path.join(root, "workspaces")
        work_dir = os.path.join(workspace_root, "ticket")
        os.makedirs(seed, exist_ok=True)
        _git(seed, "init", "-b", "main")
        _git(seed, "config", "user.name", "Test")
        _git(seed, "config", "user.email", "test@example.com")
        with open(os.path.join(seed, "README.md"), "w") as handle:
            handle.write("# fixture\n")
        _git(seed, "add", "README.md")
        _git(seed, "commit", "-m", "fixture")
        _git(root, "clone", "--bare", seed, remote)

        repository = {
            "provider": "github",
            "owner": "acme",
            "name": "widgets",
            "fullName": "acme/widgets",
            "https": "https://github.com/acme/widgets.git",
        }

        def make_broker(branch):
            return RepositoryBroker(
                provider="github",
                repository=repository,
                workspace_root=workspace_root,
                work_dir=work_dir,
                branch=branch,
                exec_file_impl=_redirect_exec(remote),
            )

        first = make_broker("task-aaa")
        await first.prepare()
        first.dispose()

        with open(os.path.join(work_dir, "scaffold.js"), "w") as handle:
            handle.write('console.log("wip")\n')
        with open(os.path.join(work_dir, "README.md"), "w") as handle:
            handle.write("# fixture\nuncommitted edit\n")
        assert _git(work_dir, "status", "--porcelain") != ""

        second = make_broker("task-bbb")
        try:
            info = await second.prepare()
            assert info["branch"] == "task-bbb"
            assert not os.path.exists(os.path.join(work_dir, "scaffold.js"))
            with open(os.path.join(work_dir, "README.md")) as handle:
                assert handle.read() == "# fixture\n"
            assert _git(work_dir, "status", "--porcelain") == ""
        finally:
            second.dispose()
    finally:
        shutil.rmtree(root, ignore_errors=True)
