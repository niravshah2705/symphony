"""Per-ticket / per-project workspaces for the code-writer agent.

Faithful port of ``packages/shared/src/agent/workspace.js``. Credentialed
repository operations are delegated to :class:`RepositoryBroker`; the checkout
only ever contains a canonical, tokenless origin and the shell receives a small
allowlisted environment via :func:`build_safe_agent_env`.
"""

from __future__ import annotations

import hashlib
import os
import re

from ai_fleet.config import CONFIG

from .repository_broker import RepositoryBroker, build_safe_agent_env


def sanitize_slug(name):
    """Slug for a filesystem dir — lowercased, alnum + hyphen only (no traversal)."""
    slug = str(name or "").lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"^-+|-+$", "", slug)
    slug = slug[:60]
    return slug or "project"


def sanitize_branch(name):
    """git-safe branch from an untrusted task shortname (command-injection guard)."""
    branch = str(name or "").strip()
    branch = re.sub(r"[^A-Za-z0-9._/-]+", "-", branch)
    branch = re.sub(r"\.\.+", "-", branch)
    branch = re.sub(r"^[-/.]+|[-/.]+$", "", branch)
    branch = branch[:80]
    return branch or "task"


def scoped_project_slug(name, project_id):
    """Stable project workspace name; the id digest prevents same-name collisions."""
    slug = sanitize_slug(name or project_id)
    stable_id = str(project_id or name or "project")
    digest = hashlib.sha256(stable_id.encode("utf-8")).hexdigest()[:10]
    return f"{slug}-{digest}"


def planned_task_workdir(root, project_slug, project_id, task_branch):
    """Absolute per-task workspace path: <root>/<project-slug>/<task-slug>.

    Distinct per task branch so a project's concurrent tasks never share a working
    tree, and stable per branch so a retry of the same task reuses its checkout.
    """
    slug = scoped_project_slug(project_slug, project_id)
    task_dir = sanitize_slug(sanitize_branch(task_branch))
    return os.path.join(root, slug, task_dir)


def repo_parts(repo_url, selected_provider="github"):
    """Parse a GitHub/GitLab repo reference into a display name + tokenless URL.

    Bare namespace/repo values use the selected provider. Explicit URLs are
    restricted to the selected official host; GitHub has exactly owner/repo while
    GitLab may contain nested groups.
    """
    text = str(repo_url or "").strip()
    provider = str(selected_provider or "").lower()
    if provider not in ("github", "gitlab"):
        return None
    expected_host = "gitlab.com" if provider == "gitlab" else "github.com"

    def clean_path(value):
        value = re.sub(r"^/+|/+$", "", str(value or ""))
        return re.sub(r"\.git$", "", value, flags=re.IGNORECASE)

    def from_path(host, value):
        repo_path = clean_path(value)
        segments = [s for s in repo_path.split("/") if s]
        if host != expected_host:
            return None
        if (
            len(segments) < 2
            or (provider == "github" and len(segments) != 2)
            or any(
                segment in (".", "..") or not re.match(r"^[A-Za-z0-9_.-]+$", segment)
                for segment in segments
            )
        ):
            return None
        name = segments[-1]
        owner = "/".join(segments[:-1])
        return {
            "provider": provider,
            "owner": owner,
            "name": name,
            "fullName": f"{owner}/{name}",
            "https": f"https://{expected_host}/{owner}/{name}.git",
        }

    # Bare namespace/repo (GitLab may include nested groups).
    if re.match(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+(?:\.git)?$", text):
        return from_path(expected_host, text)

    match = re.match(r"^https://(github\.com|gitlab\.com)/(.+)$", text, flags=re.IGNORECASE)
    if match:
        return from_path(match.group(1).lower(), match.group(2))
    match = re.match(r"^git@(github\.com|gitlab\.com):(.+)$", text, flags=re.IGNORECASE)
    if match:
        return from_path(match.group(1).lower(), match.group(2))
    return None


def _create_broker(root, work_dir, branch, parts, repository_token, on_step):
    return RepositoryBroker(
        provider=parts["provider"],
        repository=parts,
        token=repository_token,
        workspace_root=root,
        work_dir=work_dir,
        branch=branch,
        label=CONFIG.CODER.prLabel,
        step=on_step,
    )


async def prepare_planned_workspace(
    repo_url=None,
    repository_provider="github",
    project_slug=None,
    project_id=None,
    task_branch=None,
    repository_token="",
    on_step=None,
):
    """Prepare the workspace for a planned task: one checkout PER TASK at
    ``<plannedWorkspaceRoot>/<project-slug>/<task-slug>/``.

    A project's independent tasks can run concurrently without sharing a working
    tree; the dir is keyed by the task branch so a retry reuses (and refreshes)
    its checkout while a different task gets its own isolated clone.
    """
    step = on_step if callable(on_step) else (lambda *a, **k: None)
    slug = scoped_project_slug(project_slug, project_id)
    branch = sanitize_branch(task_branch)
    root = CONFIG.CODER.plannedWorkspaceRoot
    work_dir = planned_task_workdir(root, project_slug, project_id, task_branch)
    env = build_safe_agent_env(os.environ, work_dir)
    reused = os.path.exists(os.path.join(work_dir, ".git"))

    if not repo_url:
        step("No repository configured; using an empty monorepo workspace.")
        os.makedirs(work_dir, exist_ok=True)
        return {
            "workDir": work_dir,
            "branch": branch,
            "slug": slug,
            "cloned": False,
            "reused": reused,
            "env": env,
            "repositoryBroker": None,
            "baseBranch": None,
        }

    parts = repo_parts(repo_url, repository_provider)
    if not parts:
        raise ValueError("Repository must match the selected GitHub or GitLab provider.")
    repository_broker = _create_broker(
        root=root,
        work_dir=work_dir,
        branch=branch,
        parts=parts,
        repository_token=repository_token,
        on_step=step,
    )
    try:
        step(
            f"{'Refreshing' if reused else 'Cloning'} {parts['fullName']} "
            "through the secure repository broker…"
        )
        info = await repository_broker.prepare(shallow=False)
        return {
            "workDir": work_dir,
            "branch": branch,
            "slug": slug,
            "cloned": not reused,
            "reused": reused,
            "env": env,
            "repositoryBroker": repository_broker,
            "baseBranch": info["baseBranch"],
        }
    except Exception:
        repository_broker.dispose()
        raise


async def prepare_workspace(
    repo_url=None,
    repository_provider="github",
    repository_token="",
    identifier=None,
    on_step=None,
):
    """Prepare an isolated workspace and scoped branch for one ticket."""
    step = on_step if callable(on_step) else (lambda *a, **k: None)
    safe = sanitize_slug(identifier or "ticket")
    branch = sanitize_branch(identifier or "ticket")
    root = CONFIG.CODER.workspaceRoot
    work_dir = os.path.join(root, safe)
    env = build_safe_agent_env(os.environ, work_dir)
    reused = os.path.exists(os.path.join(work_dir, ".git"))

    if not repo_url:
        step("No repository configured; using an empty workspace.")
        os.makedirs(work_dir, exist_ok=True)
        return {
            "workDir": work_dir,
            "branch": branch,
            "cloned": False,
            "reused": reused,
            "env": env,
            "repositoryBroker": None,
            "baseBranch": None,
        }

    parts = repo_parts(repo_url, repository_provider)
    if not parts:
        raise ValueError("Repository must match the selected GitHub or GitLab provider.")
    repository_broker = _create_broker(
        root=root,
        work_dir=work_dir,
        branch=branch,
        parts=parts,
        repository_token=repository_token,
        on_step=step,
    )
    try:
        step(
            f"{'Refreshing' if reused else 'Cloning'} {parts['fullName']} "
            "through the secure repository broker…"
        )
        info = await repository_broker.prepare(shallow=True)
        return {
            "workDir": work_dir,
            "branch": branch,
            "cloned": not reused,
            "reused": reused,
            "env": env,
            "repositoryBroker": repository_broker,
            "baseBranch": info["baseBranch"],
        }
    except Exception:
        repository_broker.dispose()
        raise
