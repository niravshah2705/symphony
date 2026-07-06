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

// Linear's project `description` (short summary) is capped; the long body goes
// in `content` (markdown, unbounded). Exceeding the cap => "Argument Validation Error".
const PROJECT_DESCRIPTION_MAX = 250;

function summarize(text) {
  const s = String(text || '').trim();
  if (s.length <= PROJECT_DESCRIPTION_MAX) return s;
  return `${s.slice(0, PROJECT_DESCRIPTION_MAX - 1).trimEnd()}…`;
}

async function createProject(apiKey, { name, description, teamId }) {
  const input = { name, teamIds: [teamId] };
  if (description) {
    input.description = summarize(description); // stay within Linear's cap
    input.content = String(description); // full text in the markdown body
  }
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

async function createIssue(apiKey, { teamId, projectId, projectMilestoneId, title, description, priority }) {
  const input = { teamId, projectId, title };
  if (projectMilestoneId) input.projectMilestoneId = projectMilestoneId;
  if (description) input.description = description;
  if (typeof priority === 'number') input.priority = priority;
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

/** Find a project label by name (case-insensitive), creating it if absent. */
async function getOrCreateProjectLabel(apiKey, name) {
  const data = await linearRequest(apiKey, PROJECT_LABELS_QUERY, { first: CONFIG.PAGE_SIZE });
  const wanted = String(name).trim().toLowerCase();
  const existing = data.projectLabels.nodes.find((l) => (l.name || '').toLowerCase() === wanted);
  if (existing) return existing;
  const created = await linearRequest(apiKey, PROJECT_LABEL_CREATE_MUTATION, { input: { name } });
  if (!created.projectLabelCreate || !created.projectLabelCreate.success) {
    throw new LinearError(`Failed to create project label "${name}".`, 400);
  }
  return created.projectLabelCreate.projectLabel;
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
  setProjectLabels,
};
