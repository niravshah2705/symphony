"""Port of packages/shared/src/agent/workspace.test.js."""

from ai_fleet.agent.workspace import (
    planned_task_workdir,
    repo_parts,
    sanitize_branch,
    sanitize_slug,
    scoped_project_slug,
)


def test_repo_parts_accepts_owner_name_and_normalizes_github_url():
    assert repo_parts("acme/widgets") == {
        "provider": "github",
        "owner": "acme",
        "name": "widgets",
        "fullName": "acme/widgets",
        "https": "https://github.com/acme/widgets.git",
    }


def test_repo_parts_supports_gitlab_groups_and_rejects_unrelated_hosts():
    assert repo_parts("acme/platform/widgets", "gitlab") == {
        "provider": "gitlab",
        "owner": "acme/platform",
        "name": "widgets",
        "fullName": "acme/platform/widgets",
        "https": "https://gitlab.com/acme/platform/widgets.git",
    }
    assert repo_parts("https://example.com/acme/widgets.git", "github") is None
    assert repo_parts("https://gitlab.com/acme/widgets.git", "github") is None
    assert repo_parts("git@github.com:acme/widgets.git", "gitlab") is None


def test_repo_parts_enforces_namespace_shape_and_host_matching():
    assert repo_parts("acme/platform/widgets", "github") is None
    assert repo_parts("https://gitlab.com/acme/widgets.git", "github") is None
    assert repo_parts("https://github.com/acme/widgets.git", "gitlab") is None
    assert repo_parts("acme/../widgets", "gitlab") is None
    assert repo_parts("acme/widgets", "bitbucket") is None


def test_workspace_name_sanitizers_remove_unsafe_path_characters():
    assert sanitize_slug("../My Project!") == "my-project"
    assert sanitize_slug("..") == "project"
    assert sanitize_branch("../NIR 508?") == "NIR-508"


def test_planned_workspace_slug_includes_project_identity():
    import re

    assert re.match(r"^payments-[a-f0-9]{10}$", scoped_project_slug("Payments", "project-a"))
    assert scoped_project_slug("Payments", "project-a") != scoped_project_slug(
        "Payments", "project-b"
    )
    assert scoped_project_slug("Payments", "project-a") == scoped_project_slug(
        "Payments", "project-a"
    )


def test_planned_task_workdir_is_per_task_so_concurrent_tasks_are_isolated():
    root = "/tmp/ws"
    a = planned_task_workdir(root, "Payments", "project-a", "NIR-1")
    b = planned_task_workdir(root, "Payments", "project-a", "NIR-2")
    # Same project, different tasks -> different working directories.
    assert a != b
    # Both live under the project's scoped directory.
    project_dir = f"{root}/{scoped_project_slug('Payments', 'project-a')}"
    assert a.startswith(f"{project_dir}/") and b.startswith(f"{project_dir}/")
    # Stable per task branch so a retry reuses the same checkout.
    assert a == planned_task_workdir(root, "Payments", "project-a", "NIR-1")
    # Filesystem-safe leaf (no slashes even for slash-bearing branch names).
    nested = planned_task_workdir(root, "Payments", "project-a", "feature/x")
    assert len(nested.split("/")) == len(a.split("/"))
