"""Thin async wrapper around the Linear GraphQL API (port of packages/shared/src/linear.js).

Personal API keys are passed directly in the Authorization header.
"""

from __future__ import annotations

import httpx

from .config import CONFIG


class LinearError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.name = "LinearError"
        self.status = status


async def linear_request(api_key: str, query: str, variables: dict | None = None):
    if variables is None:
        variables = {}
    if not api_key:
        raise LinearError("Linear API key is not configured. Add it in Settings.", 400)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                CONFIG.LINEAR_API_URL,
                headers={"Content-Type": "application/json", "Authorization": api_key},
                json={"query": query, "variables": variables},
            )
    except httpx.HTTPError:
        raise LinearError("Unable to reach the Linear API. Check your connection.", 502)

    try:
        payload = response.json()
    except Exception:
        payload = None

    if response.status_code in (401, 403):
        raise LinearError("Linear rejected the API key. Verify it in Settings.", 401)

    if response.status_code >= 400:
        message = None
        if payload and payload.get("errors"):
            message = payload["errors"][0].get("message")
        raise LinearError(message or f"Linear API error ({response.status_code}).", 502)

    if payload and payload.get("errors"):
        raise LinearError(payload["errors"][0]["message"], 400)

    return payload["data"]


# ------------------------------- Queries ---------------------------------- #

VIEWER_QUERY = """
  query Viewer {
    viewer { id name email }
    organization { id name urlKey }
  }
"""

TEAMS_QUERY = """
  query Teams($first: Int!) {
    teams(first: $first) {
      nodes { id name key }
    }
  }
"""

PROJECTS_QUERY = """
  query Projects($first: Int!) {
    projects(first: $first) {
      nodes {
        id
        name
        description
        state
        progress
        startDate
        targetDate
        color
        lead { id name displayName }
        labels { nodes { id name } }
      }
    }
  }
"""

PROJECT_MILESTONES_QUERY = """
  query ProjectMilestones($id: String!) {
    project(id: $id) {
      id
      name
      description
      state
      progress
      startDate
      targetDate
      projectMilestones(first: 100) {
        nodes { id name description targetDate sortOrder }
      }
    }
  }
"""

PROJECT_ISSUES_QUERY = """
  query ProjectIssues($id: String!, $first: Int!) {
    project(id: $id) {
      id
      name
      issues(first: $first) {
        nodes {
          id
          identifier
          title
          priority
          priorityLabel
          url
          state { id name type color position }
          assignee { name displayName }
          projectMilestone { id name }
        }
      }
    }
  }
"""

ISSUE_UPDATE_STATE_MUTATION = """
  mutation IssueUpdate($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { id state { id name type } }
    }
  }
"""

ISSUE_UPDATE_MUTATION = """
  mutation IssueUpdateFull($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id identifier state { id name type } labels { nodes { id name } } }
    }
  }
"""

TEAM_STATES_QUERY = """
  query TeamStates($id: String!) {
    team(id: $id) {
      id
      states(first: 50) { nodes { id name type position } }
    }
  }
"""

ISSUE_DETAIL_QUERY = """
  query IssueDetail($id: String!) {
    issue(id: $id) {
      id
      identifier
      state { id name type }
      team { id name key }
      labels { nodes { id name } }
    }
  }
"""

COMMENT_CREATE_MUTATION = """
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id url }
    }
  }
"""

PROJECT_CREATE_MUTATION = """
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project { id name }
    }
  }
"""

USERS_QUERY = """
  query Users($first: Int!) {
    users(first: $first, filter: { active: { eq: true } }) {
      nodes { id name displayName email active }
    }
  }
"""

PROJECT_TEAM_QUERY = """
  query ProjectTeam($id: String!) {
    project(id: $id) {
      id
      name
      lead { id name }
      teams(first: 1) { nodes { id name key } }
    }
  }
"""

PROJECT_UPDATE_MUTATION = """
  mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project { id name description }
    }
  }
"""

MILESTONE_CREATE_MUTATION = """
  mutation MilestoneCreate($input: ProjectMilestoneCreateInput!) {
    projectMilestoneCreate(input: $input) {
      success
      projectMilestone { id name targetDate }
    }
  }
"""

MILESTONE_UPDATE_MUTATION = """
  mutation MilestoneUpdate($id: String!, $input: ProjectMilestoneUpdateInput!) {
    projectMilestoneUpdate(id: $id, input: $input) {
      success
      projectMilestone { id name }
    }
  }
"""

ISSUE_CREATE_MUTATION = """
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title url }
    }
  }
"""

ISSUE_RELATION_CREATE_MUTATION = """
  mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation { id type }
    }
  }
"""

PROJECT_LABELS_QUERY = """
  query ProjectLabels($first: Int!) {
    projectLabels(first: $first) { nodes { id name } }
  }
"""

PROJECT_LABEL_CREATE_MUTATION = """
  mutation ProjectLabelCreate($input: ProjectLabelCreateInput!) {
    projectLabelCreate(input: $input) {
      success
      projectLabel { id name }
    }
  }
"""

ISSUE_LABELS_QUERY = """
  query IssueLabels($first: Int!) {
    issueLabels(first: $first) { nodes { id name isGroup parent { id } } }
  }
"""

ISSUE_LABEL_CREATE_MUTATION = """
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel { id name isGroup parent { id } }
    }
  }
"""

ISSUE_LABEL_UPDATE_MUTATION = """
  mutation IssueLabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
    issueLabelUpdate(id: $id, input: $input) {
      success
      issueLabel { id name isGroup parent { id } }
    }
  }
"""

PROJECT_DESCRIPTION_MAX = 250


def _summarize(text) -> str:
    s = str(text or "").strip()
    if len(s) <= PROJECT_DESCRIPTION_MAX:
        return s
    return f"{s[: PROJECT_DESCRIPTION_MAX - 1].rstrip()}…"


def _sort_milestone_key(m):
    # Mirror sortMilestones: dated milestones first (ascending), then by sortOrder.
    date = m.get("targetDate") or ""
    return (0, date) if date else (1, m.get("sortOrder") or 0)


def _sorted_milestones(nodes):
    dated = sorted([m for m in nodes if m.get("targetDate")], key=lambda m: (m.get("targetDate"), m.get("sortOrder") or 0))
    undated = sorted([m for m in nodes if not m.get("targetDate")], key=lambda m: m.get("sortOrder") or 0)
    return dated + undated


# --------------------------- Public helpers ----------------------------- #


async def get_viewer(api_key: str):
    data = await linear_request(api_key, VIEWER_QUERY)
    return {"viewer": data["viewer"], "organization": data["organization"]}


async def get_teams(api_key: str):
    data = await linear_request(api_key, TEAMS_QUERY, {"first": CONFIG.PAGE_SIZE})
    return data["teams"]["nodes"]


async def get_projects(api_key: str):
    data = await linear_request(api_key, PROJECTS_QUERY, {"first": CONFIG.PAGE_SIZE})
    return data["projects"]["nodes"]


async def get_project_milestones(api_key: str, project_id: str):
    data = await linear_request(api_key, PROJECT_MILESTONES_QUERY, {"id": project_id})
    if not data.get("project"):
        raise LinearError("Project not found.", 404)
    project = data["project"]
    milestones = _sorted_milestones(project["projectMilestones"]["nodes"])
    return {"project": project, "milestones": milestones}


async def get_project_issues(api_key: str, project_id: str):
    data = await linear_request(api_key, PROJECT_ISSUES_QUERY, {"id": project_id, "first": CONFIG.ISSUE_PAGE_SIZE})
    if not data.get("project"):
        raise LinearError("Project not found.", 404)
    return data["project"]


async def update_issue_state(api_key: str, issue_id: str, state_id: str):
    data = await linear_request(api_key, ISSUE_UPDATE_STATE_MUTATION, {"id": issue_id, "stateId": state_id})
    if not data.get("issueUpdate") or not data["issueUpdate"]["success"]:
        raise LinearError("Failed to move the issue.", 400)
    return data["issueUpdate"]["issue"]


async def update_issue(api_key: str, issue_id: str, input: dict):
    data = await linear_request(api_key, ISSUE_UPDATE_MUTATION, {"id": issue_id, "input": input})
    if not data.get("issueUpdate") or not data["issueUpdate"]["success"]:
        raise LinearError("Failed to update the issue.", 400)
    return data["issueUpdate"]["issue"]


async def get_team_states(api_key: str, team_id: str):
    data = await linear_request(api_key, TEAM_STATES_QUERY, {"id": team_id})
    if not data.get("team"):
        raise LinearError("Team not found.", 404)
    return (data["team"].get("states") or {}).get("nodes") or []


async def get_issue_detail(api_key: str, issue_id: str):
    data = await linear_request(api_key, ISSUE_DETAIL_QUERY, {"id": issue_id})
    if not data.get("issue"):
        raise LinearError("Issue not found.", 404)
    return data["issue"]


def pick_state_by_type(states, type_: str, prefer_name: str | None = None):
    of_type = sorted((s for s in (states or []) if s.get("type") == type_), key=lambda s: s.get("position") or 0)
    of_type = list(of_type)
    if prefer_name:
        named = next((s for s in of_type if (s.get("name") or "").lower() == str(prefer_name).lower()), None)
        if named:
            return named
    return of_type[0] if of_type else None


async def create_comment(api_key: str, issue_id: str, body: str):
    data = await linear_request(api_key, COMMENT_CREATE_MUTATION, {"input": {"issueId": issue_id, "body": body}})
    if not data.get("commentCreate") or not data["commentCreate"]["success"]:
        raise LinearError("Failed to create comment.", 400)
    return data["commentCreate"]["comment"]


async def create_project(api_key: str, name: str, description: str = "", team_id: str = "", label_ids=None):
    input: dict = {"name": name, "teamIds": [team_id]}
    if description:
        input["description"] = _summarize(description)
        input["content"] = str(description)
    if isinstance(label_ids, list) and label_ids:
        input["labelIds"] = label_ids
    data = await linear_request(api_key, PROJECT_CREATE_MUTATION, {"input": input})
    if not data.get("projectCreate") or not data["projectCreate"]["success"]:
        raise LinearError("Failed to create the Linear project.", 400)
    return data["projectCreate"]["project"]


async def get_users(api_key: str):
    data = await linear_request(api_key, USERS_QUERY, {"first": CONFIG.PAGE_SIZE})
    return data["users"]["nodes"]


async def get_open_projects(api_key: str):
    projects = await get_projects(api_key)
    return [p for p in projects if not p.get("lead")]


def _project_label_set(project) -> set[str]:
    labels = (project.get("labels") or {}).get("nodes") or []
    return {(l.get("name") or "").lower() for l in labels}


def _project_has_any_label(project, wanted_lower: set[str]) -> bool:
    if not wanted_lower:
        return True
    have = _project_label_set(project)
    return any(w in have for w in wanted_lower)


async def get_all_project_labels(api_key: str):
    projects = await get_projects(api_key)
    names: set[str] = set()
    for p in projects:
        for l in (p.get("labels") or {}).get("nodes") or []:
            if l.get("name"):
                names.add(l["name"])
    return sorted(names)


async def get_projects_with_labels(api_key: str, labels):
    wanted = {str(l or "").strip().lower() for l in (labels if isinstance(labels, list) else []) if str(l or "").strip()}
    projects = await get_projects(api_key)
    return [p for p in projects if _project_has_any_label(p, wanted)]


async def get_milestones_with_issue_counts(api_key: str, project_id: str):
    result = await get_project_milestones(api_key, project_id)
    project, milestones = result["project"], result["milestones"]
    with_issues = await get_project_issues(api_key, project_id)
    counts: dict[str, int] = {}
    for issue in with_issues["issues"]["nodes"]:
        mid = (issue.get("projectMilestone") or {}).get("id")
        if mid:
            counts[mid] = counts.get(mid, 0) + 1
    return {
        "project": project,
        "milestones": [{**m, "issueCount": counts.get(m["id"], 0)} for m in milestones],
    }


async def get_project_team(api_key: str, project_id: str):
    data = await linear_request(api_key, PROJECT_TEAM_QUERY, {"id": project_id})
    if not data.get("project"):
        raise LinearError("Project not found.", 404)
    teams = data["project"]["teams"]["nodes"]
    team = teams[0] if teams else None
    if not team:
        raise LinearError("Project has no team; cannot create issues.", 400)
    return {"project": data["project"], "team": team}


async def set_project_lead(api_key: str, project_id: str, lead_id: str):
    data = await linear_request(api_key, PROJECT_UPDATE_MUTATION, {"id": project_id, "input": {"leadId": lead_id}})
    if not data.get("projectUpdate") or not data["projectUpdate"]["success"]:
        raise LinearError("Failed to assign project lead.", 400)
    return data["projectUpdate"]["project"]


async def update_project_description(api_key: str, project_id: str, description: str):
    data = await linear_request(
        api_key,
        PROJECT_UPDATE_MUTATION,
        {"id": project_id, "input": {"content": str(description or ""), "description": _summarize(description)}},
    )
    if not data.get("projectUpdate") or not data["projectUpdate"]["success"]:
        raise LinearError("Failed to update project description.", 400)
    return data["projectUpdate"]["project"]


async def create_milestone(api_key: str, project_id: str, name: str, description: str = "", target_date: str = ""):
    input: dict = {"projectId": project_id, "name": name}
    if description:
        input["description"] = description
    if target_date:
        input["targetDate"] = target_date
    data = await linear_request(api_key, MILESTONE_CREATE_MUTATION, {"input": input})
    if not data.get("projectMilestoneCreate") or not data["projectMilestoneCreate"]["success"]:
        raise LinearError(f'Failed to create milestone "{name}".', 400)
    return data["projectMilestoneCreate"]["projectMilestone"]


async def update_milestone(api_key: str, id: str, description: str):
    data = await linear_request(api_key, MILESTONE_UPDATE_MUTATION, {"id": id, "input": {"description": description}})
    if not data.get("projectMilestoneUpdate") or not data["projectMilestoneUpdate"]["success"]:
        raise LinearError("Failed to update milestone.", 400)
    return data["projectMilestoneUpdate"]["projectMilestone"]


async def create_issue(
    api_key: str,
    team_id: str,
    project_id: str,
    title: str,
    project_milestone_id: str | None = None,
    description: str = "",
    priority: int | None = None,
    label_ids=None,
):
    input: dict = {"teamId": team_id, "projectId": project_id, "title": title}
    if project_milestone_id:
        input["projectMilestoneId"] = project_milestone_id
    if description:
        input["description"] = description
    if isinstance(priority, int):
        input["priority"] = priority
    if isinstance(label_ids, list) and label_ids:
        input["labelIds"] = label_ids
    data = await linear_request(api_key, ISSUE_CREATE_MUTATION, {"input": input})
    if not data.get("issueCreate") or not data["issueCreate"]["success"]:
        raise LinearError(f'Failed to create issue "{title}".', 400)
    return data["issueCreate"]["issue"]


async def create_issue_relation(api_key: str, issue_id: str, related_issue_id: str, type_: str = "blocks"):
    data = await linear_request(
        api_key,
        ISSUE_RELATION_CREATE_MUTATION,
        {"input": {"issueId": issue_id, "relatedIssueId": related_issue_id, "type": type_}},
    )
    if not data.get("issueRelationCreate") or not data["issueRelationCreate"]["success"]:
        raise LinearError("Failed to create issue dependency.", 400)
    return data["issueRelationCreate"]["issueRelation"]


async def _fetch_project_labels_by_lower(api_key: str) -> dict:
    data = await linear_request(api_key, PROJECT_LABELS_QUERY, {"first": CONFIG.PAGE_SIZE})
    return {(l.get("name") or "").lower(): l for l in data["projectLabels"]["nodes"]}


async def _resolve_or_create_label(api_key: str, name: str, existing_by_lower: dict):
    existing = existing_by_lower.get(str(name).strip().lower())
    if existing:
        return existing
    created = await linear_request(api_key, PROJECT_LABEL_CREATE_MUTATION, {"input": {"name": name}})
    if not created.get("projectLabelCreate") or not created["projectLabelCreate"]["success"]:
        raise LinearError(f'Failed to create project label "{name}".', 400)
    return created["projectLabelCreate"]["projectLabel"]


async def get_or_create_project_label(api_key: str, name: str):
    return await _resolve_or_create_label(api_key, name, await _fetch_project_labels_by_lower(api_key))


async def get_or_create_project_labels(api_key: str, names):
    seen: set[str] = set()
    cleaned: list[str] = []
    for raw in names if isinstance(names, list) else []:
        name = str(raw or "").strip()
        lower = name.lower()
        if not name or lower in seen:
            continue
        seen.add(lower)
        cleaned.append(name)
    if not cleaned:
        return []
    existing_by_lower = await _fetch_project_labels_by_lower(api_key)
    return [await _resolve_or_create_label(api_key, name, existing_by_lower) for name in cleaned]


async def _fetch_issue_label_nodes(api_key: str):
    data = await linear_request(api_key, ISSUE_LABELS_QUERY, {"first": CONFIG.PAGE_SIZE})
    return (data.get("issueLabels") or {}).get("nodes") or []


def find_issue_label(nodes, name: str, group: bool | None = None):
    wanted = str(name).strip().lower()
    for l in nodes or []:
        if (l.get("name") or "").lower() == wanted and (group is None or bool(l.get("isGroup")) == group):
            return l
    return None


async def _create_issue_label(api_key: str, input: dict):
    created = await linear_request(api_key, ISSUE_LABEL_CREATE_MUTATION, {"input": input})
    if not created.get("issueLabelCreate") or not created["issueLabelCreate"]["success"]:
        raise LinearError(f"Failed to create issue label \"{input.get('name')}\".", 400)
    return created["issueLabelCreate"]["issueLabel"]


async def get_or_create_issue_label(api_key: str, name: str):
    existing = find_issue_label(await _fetch_issue_label_nodes(api_key), name)
    return existing or await _create_issue_label(api_key, {"name": name})


async def get_or_create_issue_label_group(api_key: str, name: str):
    existing = find_issue_label(await _fetch_issue_label_nodes(api_key), name, group=True)
    return existing or await _create_issue_label(api_key, {"name": name, "isGroup": True})


async def get_or_create_grouped_issue_label(api_key: str, group_name: str, child_name: str):
    group = await get_or_create_issue_label_group(api_key, group_name)
    nodes = await _fetch_issue_label_nodes(api_key)
    existing = find_issue_label(nodes, child_name, group=False)
    if not existing:
        return await _create_issue_label(api_key, {"name": child_name, "parentId": group["id"]})
    if existing.get("parent") and existing["parent"].get("id") == group["id"]:
        return existing
    updated = await linear_request(
        api_key, ISSUE_LABEL_UPDATE_MUTATION, {"id": existing["id"], "input": {"parentId": group["id"]}}
    )
    if not updated.get("issueLabelUpdate") or not updated["issueLabelUpdate"]["success"]:
        raise LinearError(f'Failed to move issue label "{child_name}" into "{group_name}".', 400)
    return updated["issueLabelUpdate"]["issueLabel"]


async def set_project_labels(api_key: str, project_id: str, label_ids):
    data = await linear_request(api_key, PROJECT_UPDATE_MUTATION, {"id": project_id, "input": {"labelIds": label_ids}})
    if not data.get("projectUpdate") or not data["projectUpdate"]["success"]:
        raise LinearError("Failed to update project labels.", 400)
    return data["projectUpdate"]["project"]
