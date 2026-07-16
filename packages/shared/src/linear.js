'use strict';

const { CONFIG } = require('./config');

/**
 * Thin wrapper around the Linear GraphQL API.
 * Personal API keys are passed directly in the Authorization header.
 */

class LinearError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LinearError';
    this.status = status;
  }
}

async function linearRequest(apiKey, query, variables = {}) {
  if (!apiKey) {
    throw new LinearError('Linear API key is not configured. Add it in Settings.', 400);
  }

  let response;
  try {
    response = await fetch(CONFIG.LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (cause) {
    throw new LinearError('Unable to reach the Linear API. Check your connection.', 502);
  }

  const payload = await response.json().catch(() => null);

  if (response.status === 401 || response.status === 403) {
    throw new LinearError('Linear rejected the API key. Verify it in Settings.', 401);
  }

  if (!response.ok) {
    const message =
      payload && payload.errors && payload.errors[0] && payload.errors[0].message;
    throw new LinearError(message || `Linear API error (${response.status}).`, 502);
  }

  if (payload && payload.errors && payload.errors.length) {
    throw new LinearError(payload.errors[0].message, 400);
  }

  return payload.data;
}

/* ----------------------------- Queries ---------------------------------- */

const VIEWER_QUERY = `
  query Viewer {
    viewer { id name email }
    organization { id name urlKey }
  }
`;

const TEAMS_QUERY = `
  query Teams($first: Int!) {
    teams(first: $first) {
      nodes { id name key }
    }
  }
`;

const PROJECTS_QUERY = `
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
`;

const PROJECT_MILESTONES_QUERY = `
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
`;

const PROJECT_ISSUES_QUERY = `
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
`;

const ISSUE_UPDATE_STATE_MUTATION = `
  mutation IssueUpdate($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { id state { id name type } }
    }
  }
`;

// General issue update — state and/or labels in one mutation (labelIds REPLACES
// the full set, so callers append to the issue's existing labels).
const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdateFull($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id identifier state { id name type } labels { nodes { id name } } }
    }
  }
`;

// A team's workflow states (id + Linear `type`: backlog|unstarted|started|completed|canceled).
const TEAM_STATES_QUERY = `
  query TeamStates($id: String!) {
    team(id: $id) {
      id
      states(first: 50) { nodes { id name type position } }
    }
  }
`;

// Issue detail needed to drive state/label transitions (team + current labels/state).
const ISSUE_DETAIL_QUERY = `
  query IssueDetail($id: String!) {
    issue(id: $id) {
      id
      identifier
      state { id name type }
      team { id name key }
      labels { nodes { id name } }
    }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id url }
    }
  }
`;

const PROJECT_CREATE_MUTATION = `
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project { id name }
    }
  }
`;

const USERS_QUERY = `
  query Users($first: Int!) {
    users(first: $first, filter: { active: { eq: true } }) {
      nodes { id name displayName email active }
    }
  }
`;

// Project + its first team (issues must be created under a team).
const PROJECT_TEAM_QUERY = `
  query ProjectTeam($id: String!) {
    project(id: $id) {
      id
      name
      lead { id name }
      teams(first: 1) { nodes { id name key } }
    }
  }
`;

const PROJECT_UPDATE_MUTATION = `
  mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project { id name description }
    }
  }
`;

const MILESTONE_CREATE_MUTATION = `
  mutation MilestoneCreate($input: ProjectMilestoneCreateInput!) {
    projectMilestoneCreate(input: $input) {
      success
      projectMilestone { id name targetDate }
    }
  }
`;

const MILESTONE_UPDATE_MUTATION = `
  mutation MilestoneUpdate($id: String!, $input: ProjectMilestoneUpdateInput!) {
    projectMilestoneUpdate(id: $id, input: $input) {
      success
      projectMilestone { id name }
    }
  }
`;

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title }
    }
  }
`;

const ISSUE_RELATION_CREATE_MUTATION = `
  mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation { id type }
    }
  }
`;

const PROJECT_LABELS_QUERY = `
  query ProjectLabels($first: Int!) {
    projectLabels(first: $first) { nodes { id name } }
  }
`;

const PROJECT_LABEL_CREATE_MUTATION = `
  mutation ProjectLabelCreate($input: ProjectLabelCreateInput!) {
    projectLabelCreate(input: $input) {
      success
      projectLabel { id name }
    }
  }
`;

// Issue labels are a distinct entity from project labels in Linear. `isGroup`
// marks a parent (group) label; `parent.id` links a child to its group.
const ISSUE_LABELS_QUERY = `
  query IssueLabels($first: Int!) {
    issueLabels(first: $first) { nodes { id name isGroup parent { id } } }
  }
`;

const ISSUE_LABEL_CREATE_MUTATION = `
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel { id name isGroup parent { id } }
    }
  }
`;

const ISSUE_LABEL_UPDATE_MUTATION = `
  mutation IssueLabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
    issueLabelUpdate(id: $id, input: $input) {
      success
      issueLabel { id name isGroup parent { id } }
    }
  }
`;

/* --------------------------- Public helpers ----------------------------- */

async function getViewer(apiKey) {
  const data = await linearRequest(apiKey, VIEWER_QUERY);
  return { viewer: data.viewer, organization: data.organization };
}

async function getTeams(apiKey) {
  const data = await linearRequest(apiKey, TEAMS_QUERY, { first: CONFIG.PAGE_SIZE });
  return data.teams.nodes;
}

async function getProjects(apiKey) {
  const data = await linearRequest(apiKey, PROJECTS_QUERY, { first: CONFIG.PAGE_SIZE });
  return data.projects.nodes;
}

async function getProjectMilestones(apiKey, projectId) {
  const data = await linearRequest(apiKey, PROJECT_MILESTONES_QUERY, { id: projectId });
  if (!data.project) throw new LinearError('Project not found.', 404);
  const project = data.project;
  const milestones = [...project.projectMilestones.nodes].sort(sortMilestones);
  return { project, milestones };
}

async function getProjectIssues(apiKey, projectId) {
  const data = await linearRequest(apiKey, PROJECT_ISSUES_QUERY, {
    id: projectId,
    first: CONFIG.ISSUE_PAGE_SIZE,
  });
  if (!data.project) throw new LinearError('Project not found.', 404);
  return data.project;
}

async function updateIssueState(apiKey, issueId, stateId) {
  const data = await linearRequest(apiKey, ISSUE_UPDATE_STATE_MUTATION, {
    id: issueId,
    stateId,
  });
  if (!data.issueUpdate || !data.issueUpdate.success) {
    throw new LinearError('Failed to move the issue.', 400);
  }
  return data.issueUpdate.issue;
}

/** Update an issue's state and/or labels (input passed straight to IssueUpdateInput). */
async function updateIssue(apiKey, issueId, input) {
  const data = await linearRequest(apiKey, ISSUE_UPDATE_MUTATION, { id: issueId, input });
  if (!data.issueUpdate || !data.issueUpdate.success) {
    throw new LinearError('Failed to update the issue.', 400);
  }
  return data.issueUpdate.issue;
}

/** Workflow states for a team (each carries a Linear `type`). */
async function getTeamStates(apiKey, teamId) {
  const data = await linearRequest(apiKey, TEAM_STATES_QUERY, { id: teamId });
  if (!data.team) throw new LinearError('Team not found.', 404);
  return (data.team.states && data.team.states.nodes) || [];
}

/** Issue detail (team + current state + labels) used to drive transitions. */
async function getIssueDetail(apiKey, issueId) {
  const data = await linearRequest(apiKey, ISSUE_DETAIL_QUERY, { id: issueId });
  if (!data.issue) throw new LinearError('Issue not found.', 404);
  return data.issue;
}

/**
 * Pick a workflow state by Linear `type` (backlog|unstarted|started|completed|
 * canceled), preferring one whose name matches `preferName`, else the lowest
 * `position` of that type. Returns null when no state of that type exists.
 */
function pickStateByType(states, type, preferName) {
  const ofType = (states || [])
    .filter((s) => s.type === type)
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  if (preferName) {
    const named = ofType.find((s) => (s.name || '').toLowerCase() === String(preferName).toLowerCase());
    if (named) return named;
  }
  return ofType[0] || null;
}

/** Post a comment on an issue. */
async function createComment(apiKey, { issueId, body }) {
  const data = await linearRequest(apiKey, COMMENT_CREATE_MUTATION, { input: { issueId, body } });
  if (!data.commentCreate || !data.commentCreate.success) {
    throw new LinearError('Failed to create comment.', 400);
  }
  return data.commentCreate.comment;
}

// Linear's project `description` (short summary) is capped; the long body goes
// in `content` (markdown, unbounded). Exceeding the cap => "Argument Validation Error".
const PROJECT_DESCRIPTION_MAX = 250;

function summarize(text) {
  const s = String(text || '').trim();
  if (s.length <= PROJECT_DESCRIPTION_MAX) return s;
  return `${s.slice(0, PROJECT_DESCRIPTION_MAX - 1).trimEnd()}…`;
}

async function createProject(apiKey, { name, description, teamId, labelIds }) {
  const input = { name, teamIds: [teamId] };
  if (description) {
    input.description = summarize(description); // stay within Linear's cap
    input.content = String(description); // full text in the markdown body
  }
  // Attach labels atomically at creation (ProjectCreateInput.labelIds) so a new
  // project never briefly exists unlabeled.
  if (Array.isArray(labelIds) && labelIds.length) input.labelIds = labelIds;
  const data = await linearRequest(apiKey, PROJECT_CREATE_MUTATION, { input });
  if (!data.projectCreate || !data.projectCreate.success) {
    throw new LinearError('Failed to create the Linear project.', 400);
  }
  return data.projectCreate.project;
}

async function getUsers(apiKey) {
  const data = await linearRequest(apiKey, USERS_QUERY, { first: CONFIG.PAGE_SIZE });
  return data.users.nodes;
}

/** Projects with no lead assigned — candidates for enrichment. */
async function getOpenProjects(apiKey) {
  const projects = await getProjects(apiKey);
  return projects.filter((p) => !p.lead);
}

function projectLabelSet(project) {
  const labels = (project.labels && project.labels.nodes) || [];
  return new Set(labels.map((l) => (l.name || '').toLowerCase()));
}

function projectHasAnyLabel(project, wantedLowerSet) {
  if (!wantedLowerSet.size) return true; // no labels selected => all open projects
  const have = projectLabelSet(project);
  for (const w of wantedLowerSet) if (have.has(w)) return true;
  return false;
}

/** Distinct project label names across all projects (for the label dropdown). */
async function getAllProjectLabels(apiKey) {
  const projects = await getProjects(apiKey);
  const names = new Set();
  for (const p of projects) {
    for (const l of (p.labels && p.labels.nodes) || []) {
      if (l.name) names.add(l.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Projects carrying ANY of the given labels (regardless of lead) — the managed
 * enrichment set. Since `aidone`/`aifail` replace the enrich label, a project
 * still carrying it always has outstanding work (new plan or resume). An
 * empty/blank label list matches all projects.
 */
async function getProjectsWithLabels(apiKey, labels) {
  const wanted = new Set(
    (Array.isArray(labels) ? labels : [])
      .map((l) => String(l || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const projects = await getProjects(apiKey);
  return projects.filter((p) => projectHasAnyLabel(p, wanted));
}

/** Milestones for a project annotated with how many issues each already has. */
async function getMilestonesWithIssueCounts(apiKey, projectId) {
  const { project, milestones } = await getProjectMilestones(apiKey, projectId);
  const withIssues = await getProjectIssues(apiKey, projectId);
  const counts = new Map();
  for (const issue of withIssues.issues.nodes) {
    const mid = issue.projectMilestone && issue.projectMilestone.id;
    if (mid) counts.set(mid, (counts.get(mid) || 0) + 1);
  }
  return {
    project,
    milestones: milestones.map((m) => ({ ...m, issueCount: counts.get(m.id) || 0 })),
  };
}

async function getProjectTeam(apiKey, projectId) {
  const data = await linearRequest(apiKey, PROJECT_TEAM_QUERY, { id: projectId });
  if (!data.project) throw new LinearError('Project not found.', 404);
  const team = data.project.teams.nodes[0];
  if (!team) throw new LinearError('Project has no team; cannot create issues.', 400);
  return { project: data.project, team };
}

async function setProjectLead(apiKey, projectId, leadId) {
  const data = await linearRequest(apiKey, PROJECT_UPDATE_MUTATION, {
    id: projectId,
    input: { leadId },
  });
  if (!data.projectUpdate || !data.projectUpdate.success) {
    throw new LinearError('Failed to assign project lead.', 400);
  }
  return data.projectUpdate.project;
}

async function updateProjectDescription(apiKey, projectId, description) {
  // Long overviews go in `content`; keep a short summary in `description`.
  const data = await linearRequest(apiKey, PROJECT_UPDATE_MUTATION, {
    id: projectId,
    input: { content: String(description || ''), description: summarize(description) },
  });
  if (!data.projectUpdate || !data.projectUpdate.success) {
    throw new LinearError('Failed to update project description.', 400);
  }
  return data.projectUpdate.project;
}

async function createMilestone(apiKey, { projectId, name, description, targetDate }) {
  const input = { projectId, name };
  if (description) input.description = description;
  if (targetDate) input.targetDate = targetDate;
  const data = await linearRequest(apiKey, MILESTONE_CREATE_MUTATION, { input });
  if (!data.projectMilestoneCreate || !data.projectMilestoneCreate.success) {
    throw new LinearError(`Failed to create milestone "${name}".`, 400);
  }
  return data.projectMilestoneCreate.projectMilestone;
}

async function updateMilestone(apiKey, { id, description }) {
  const data = await linearRequest(apiKey, MILESTONE_UPDATE_MUTATION, { id, input: { description } });
  if (!data.projectMilestoneUpdate || !data.projectMilestoneUpdate.success) {
    throw new LinearError('Failed to update milestone.', 400);
  }
  return data.projectMilestoneUpdate.projectMilestone;
}

async function createIssue(apiKey, { teamId, projectId, projectMilestoneId, title, description, priority, labelIds }) {
  const input = { teamId, projectId, title };
  if (projectMilestoneId) input.projectMilestoneId = projectMilestoneId;
  if (description) input.description = description;
  if (typeof priority === 'number') input.priority = priority;
  if (Array.isArray(labelIds) && labelIds.length) input.labelIds = labelIds;
  const data = await linearRequest(apiKey, ISSUE_CREATE_MUTATION, { input });
  if (!data.issueCreate || !data.issueCreate.success) {
    throw new LinearError(`Failed to create issue "${title}".`, 400);
  }
  return data.issueCreate.issue;
}

async function createIssueRelation(apiKey, { issueId, relatedIssueId, type = 'blocks' }) {
  const data = await linearRequest(apiKey, ISSUE_RELATION_CREATE_MUTATION, {
    input: { issueId, relatedIssueId, type },
  });
  if (!data.issueRelationCreate || !data.issueRelationCreate.success) {
    throw new LinearError('Failed to create issue dependency.', 400);
  }
  return data.issueRelationCreate.issueRelation;
}

/** Fetch existing project labels as a Map keyed by lowercased name. */
async function fetchProjectLabelsByLower(apiKey) {
  const data = await linearRequest(apiKey, PROJECT_LABELS_QUERY, { first: CONFIG.PAGE_SIZE });
  return new Map(data.projectLabels.nodes.map((l) => [(l.name || '').toLowerCase(), l]));
}

/** Return the existing label for `name`, or create it (given a prefetched map). */
async function resolveOrCreateLabel(apiKey, name, existingByLower) {
  const existing = existingByLower.get(String(name).trim().toLowerCase());
  if (existing) return existing;
  const created = await linearRequest(apiKey, PROJECT_LABEL_CREATE_MUTATION, { input: { name } });
  if (!created.projectLabelCreate || !created.projectLabelCreate.success) {
    throw new LinearError(`Failed to create project label "${name}".`, 400);
  }
  return created.projectLabelCreate.projectLabel;
}

/** Find a project label by name (case-insensitive), creating it if absent. */
async function getOrCreateProjectLabel(apiKey, name) {
  return resolveOrCreateLabel(apiKey, name, await fetchProjectLabelsByLower(apiKey));
}

/**
 * Resolve a list of label names to label objects (with ids), creating any that
 * don't exist. Names are de-duplicated case-insensitively; a single label fetch
 * backs the whole batch. Returns [] for an empty/blank list.
 */
async function getOrCreateProjectLabels(apiKey, names) {
  const seen = new Set();
  const cleaned = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw || '').trim();
    const lower = name.toLowerCase();
    if (!name || seen.has(lower)) continue;
    seen.add(lower);
    cleaned.push(name);
  }
  if (!cleaned.length) return [];
  const existingByLower = await fetchProjectLabelsByLower(apiKey);
  const labels = [];
  for (const name of cleaned) {
    labels.push(await resolveOrCreateLabel(apiKey, name, existingByLower));
  }
  return labels;
}

/** All issue labels in the workspace (id, name, isGroup, parent.id). */
async function fetchIssueLabelNodes(apiKey) {
  const data = await linearRequest(apiKey, ISSUE_LABELS_QUERY, { first: CONFIG.PAGE_SIZE });
  return (data.issueLabels && data.issueLabels.nodes) || [];
}

/**
 * Find an issue label by name (case-insensitive) in a prefetched node list.
 * Pass `group: true|false` to require/exclude group (parent) labels; omit to
 * match either. Pure — no network. Returns the node or null.
 */
function findIssueLabel(nodes, name, { group } = {}) {
  const wanted = String(name).trim().toLowerCase();
  return (
    (nodes || []).find(
      (l) => (l.name || '').toLowerCase() === wanted && (group === undefined || Boolean(l.isGroup) === group)
    ) || null
  );
}

/** Create an issue label from an IssueLabelCreateInput; throws on failure. */
async function createIssueLabel(apiKey, input) {
  const created = await linearRequest(apiKey, ISSUE_LABEL_CREATE_MUTATION, { input });
  if (!created.issueLabelCreate || !created.issueLabelCreate.success) {
    throw new LinearError(`Failed to create issue label "${input.name}".`, 400);
  }
  return created.issueLabelCreate.issueLabel;
}

/** Find an ISSUE label by name (case-insensitive), creating it if absent. */
async function getOrCreateIssueLabel(apiKey, name) {
  const existing = findIssueLabel(await fetchIssueLabelNodes(apiKey), name);
  return existing || createIssueLabel(apiKey, { name });
}

/**
 * Find the ISSUE label group (parent, isGroup) named `name`, creating it if
 * absent. Linear renders a group's members as a single-select dropdown on issues.
 */
async function getOrCreateIssueLabelGroup(apiKey, name) {
  const existing = findIssueLabel(await fetchIssueLabelNodes(apiKey), name, { group: true });
  return existing || createIssueLabel(apiKey, { name, isGroup: true });
}

/**
 * Resolve an issue label `childName` as a member of the `groupName` label group,
 * so it appears as an option of that dropdown in Linear. Creates the group and/or
 * the child as needed, and re-parents an existing flat label into the group.
 */
async function getOrCreateGroupedIssueLabel(apiKey, groupName, childName) {
  const group = await getOrCreateIssueLabelGroup(apiKey, groupName);
  // Re-fetch: the group may have just been created, and we need the child's
  // current parent to decide between reuse / re-parent / create.
  const nodes = await fetchIssueLabelNodes(apiKey);
  const existing = findIssueLabel(nodes, childName, { group: false });
  if (!existing) return createIssueLabel(apiKey, { name: childName, parentId: group.id });
  if (existing.parent && existing.parent.id === group.id) return existing;
  const updated = await linearRequest(apiKey, ISSUE_LABEL_UPDATE_MUTATION, {
    id: existing.id,
    input: { parentId: group.id },
  });
  if (!updated.issueLabelUpdate || !updated.issueLabelUpdate.success) {
    throw new LinearError(`Failed to move issue label "${childName}" into "${groupName}".`, 400);
  }
  return updated.issueLabelUpdate.issueLabel;
}

/** Replace a project's labels with the given label ids. */
async function setProjectLabels(apiKey, projectId, labelIds) {
  const data = await linearRequest(apiKey, PROJECT_UPDATE_MUTATION, {
    id: projectId,
    input: { labelIds },
  });
  if (!data.projectUpdate || !data.projectUpdate.success) {
    throw new LinearError('Failed to update project labels.', 400);
  }
  return data.projectUpdate.project;
}

function sortMilestones(a, b) {
  const aDate = a.targetDate || '';
  const bDate = b.targetDate || '';
  if (aDate && bDate && aDate !== bDate) return aDate < bDate ? -1 : 1;
  if (aDate && !bDate) return -1;
  if (!aDate && bDate) return 1;
  return (a.sortOrder || 0) - (b.sortOrder || 0);
}

module.exports = {
  LinearError,
  linearRequest,
  getViewer,
  getTeams,
  getProjects,
  getProjectMilestones,
  getProjectIssues,
  updateIssueState,
  updateIssue,
  getTeamStates,
  getIssueDetail,
  pickStateByType,
  createComment,
  createProject,
  getUsers,
  getOpenProjects,
  getProjectsWithLabels,
  getMilestonesWithIssueCounts,
  getAllProjectLabels,
  getProjectTeam,
  setProjectLead,
  updateProjectDescription,
  createMilestone,
  updateMilestone,
  createIssue,
  createIssueRelation,
  getOrCreateProjectLabel,
  getOrCreateProjectLabels,
  getOrCreateIssueLabel,
  findIssueLabel,
  getOrCreateIssueLabelGroup,
  getOrCreateGroupedIssueLabel,
  setProjectLabels,
};
