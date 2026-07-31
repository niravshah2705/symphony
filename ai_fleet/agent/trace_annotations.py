"""Business "annotations" for LangSmith runs (port of agent/trace-annotations.js).

Every traced run (planner + coder) is stamped with three business tags so
traces are filterable and groupable in LangSmith:
  - project  : human-readable business/project name
  - task-id  : the tracker task (Linear issue) identifier, e.g. "ENG-123"
  - session  : the top-level run id (unique per run). Also emitted as
               ``session_id``, the metadata key LangSmith's Threads view groups on.

Each value is attached BOTH as structured ``metadata`` (filterable + thread key)
and as a flat ``tag`` (``project:…``, ``task:…``, ``session:…``) for the runs
list. Absent or blank fields are omitted so we never stamp empty annotations.

Pure dict/list shaping — no side effects, never mutates its inputs.
"""

from __future__ import annotations


def _clean(value) -> str:
    """Trimmed string, or '' for None/blank."""
    if value is None:
        return ""
    return str(value).strip()


def build_annotations(business=None) -> dict:
    """Build the ``{metadata, tags}`` annotation for a business context.

    ``business`` is an optional dict with ``project`` / ``taskId`` / ``session``.
    """
    business = business or {}
    metadata: dict = {}
    tags: list = []

    project = _clean(business.get("project"))
    if project:
        metadata["project"] = project
        tags.append(f"project:{project}")

    task_id = _clean(business.get("taskId"))
    if task_id:
        metadata["task-id"] = task_id
        tags.append(f"task:{task_id}")

    session = _clean(business.get("session"))
    if session:
        metadata["session"] = session
        metadata["session_id"] = session  # LangSmith Threads grouping key
        tags.append(f"session:{session}")

    return {"metadata": metadata, "tags": tags}


def with_annotations(config=None, business=None) -> dict:
    """Merge business annotations into an existing LangChain invoke config,
    preserving any metadata/tags already present. Returns a NEW config dict
    (never mutates the input). Tags are de-duplicated with order preserved.
    """
    config = config or {}
    built = build_annotations(business)

    merged_tags = list(config.get("tags") or []) + built["tags"]
    seen = set()
    deduped_tags = []
    for tag in merged_tags:
        if tag not in seen:
            seen.add(tag)
            deduped_tags.append(tag)

    return {
        **config,
        "metadata": {**(config.get("metadata") or {}), **built["metadata"]},
        "tags": deduped_tags,
    }
