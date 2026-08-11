export const CONTEXT_STORAGE_KEY = 'ai-fleet.context';
export const CONTEXT_STORAGE_VERSION = 1;

function boundedText(value, max = 256) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || /[\r\n]/.test(text)) return '';
  return text.slice(0, max);
}

function boundedId(value) {
  const id = boundedText(value, 160);
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

function normalizeProject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = boundedId(value.id || value.project_id);
  if (!id) return null;
  return {
    id,
    name: boundedText(value.name || value.project_name) || id,
    role: boundedText(value.role, 80),
  };
}

function normalizeOrganization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = boundedId(value.id || value.org_id || value.organization_id);
  if (!id) return null;
  const seen = new Set();
  const projects = (Array.isArray(value.projects) ? value.projects : [])
    .map(normalizeProject)
    .filter((project) => {
      if (!project || seen.has(project.id)) return false;
      seen.add(project.id);
      return true;
    });
  return {
    id,
    name: boundedText(value.name || value.org_name || value.organization_name) || id,
    role: boundedText(value.role, 80),
    projects,
  };
}

/** Normalize the public GET /api/org/me/context contract and legacy field names. */
export function normalizeWorkspaceContext(payload, fallbackUser = {}) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const sourceUser = body.user && typeof body.user === 'object' ? body.user : {};
  const user = {
    id: boundedText(
      sourceUser.id || sourceUser.user_id || sourceUser.sub || sourceUser.uid ||
      fallbackUser.id || fallbackUser.user_id || fallbackUser.sub || fallbackUser.uid
    ),
    email: boundedText(sourceUser.email || fallbackUser.email, 320),
    fullName: boundedText(
      sourceUser.full_name || sourceUser.name || sourceUser.display_name ||
      fallbackUser.full_name || fallbackUser.name || fallbackUser.displayName
    ),
  };
  const seen = new Set();
  const organizations = (Array.isArray(body.organizations)
    ? body.organizations
    : Array.isArray(body.orgs) ? body.orgs : [])
    .map(normalizeOrganization)
    .filter((organization) => {
      if (!organization || seen.has(organization.id)) return false;
      seen.add(organization.id);
      return true;
    });
  return { user, organizations };
}

export function emptyContextStore() {
  return { version: CONTEXT_STORAGE_VERSION, users: {} };
}

export function readContextStore(storage) {
  if (!storage || typeof storage.getItem !== 'function') return emptyContextStore();
  try {
    const parsed = JSON.parse(storage.getItem(CONTEXT_STORAGE_KEY) || 'null');
    if (
      !parsed || parsed.version !== CONTEXT_STORAGE_VERSION ||
      !parsed.users || typeof parsed.users !== 'object' || Array.isArray(parsed.users)
    ) return emptyContextStore();
    return { version: CONTEXT_STORAGE_VERSION, users: { ...parsed.users } };
  } catch (_) {
    return emptyContextStore();
  }
}

export function readUserContextPreference(storage, userId) {
  const stableUserId = boundedText(userId);
  if (!stableUserId) return { organizationId: null, projectIdsByOrganization: {} };
  const raw = readContextStore(storage).users[stableUserId];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { organizationId: null, projectIdsByOrganization: {} };
  }
  const projectIdsByOrganization = {};
  const rawProjects = raw.projectIdsByOrganization;
  if (rawProjects && typeof rawProjects === 'object' && !Array.isArray(rawProjects)) {
    for (const [rawOrgId, rawProjectId] of Object.entries(rawProjects)) {
      const organizationId = boundedId(rawOrgId);
      const projectId = rawProjectId == null ? null : boundedId(rawProjectId);
      if (organizationId && (projectId || rawProjectId == null)) {
        projectIdsByOrganization[organizationId] = projectId || null;
      }
    }
  }
  return {
    organizationId: boundedId(raw.organizationId) || null,
    projectIdsByOrganization,
  };
}

export function persistUserContextPreference(storage, userId, preference) {
  const stableUserId = boundedText(userId);
  if (!stableUserId || !storage || typeof storage.setItem !== 'function') return false;
  const store = readContextStore(storage);
  const users = { ...store.users };
  const value = {
    organizationId: boundedId(preference && preference.organizationId) || null,
    projectIdsByOrganization: { ...((preference && preference.projectIdsByOrganization) || {}) },
  };
  // Define rather than assign so even an unusual identity such as "__proto__"
  // remains an ordinary per-user data key.
  Object.defineProperty(users, stableUserId, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  try {
    storage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify({
      version: CONTEXT_STORAGE_VERSION,
      users,
    }));
    return true;
  } catch (_) {
    return false;
  }
}

function organizationById(context, organizationId) {
  return context.organizations.find((organization) => organization.id === organizationId) || null;
}

/** Resolve missing or stale saved choices to the first accessible org/project. */
export function resolveWorkspaceSelection(context, preference = {}) {
  const organizations = Array.isArray(context && context.organizations) ? context.organizations : [];
  const savedOrganizationId = boundedId(preference.organizationId);
  const organization = organizationById({ organizations }, savedOrganizationId) || organizations[0] || null;
  const projectIdsByOrganization = { ...(preference.projectIdsByOrganization || {}) };
  if (!organization) {
    return { organizationId: null, projectId: null, projectIdsByOrganization };
  }
  const savedProjectId = boundedId(projectIdsByOrganization[organization.id]);
  const project = organization.projects.find((item) => item.id === savedProjectId)
    || organization.projects[0]
    || null;
  projectIdsByOrganization[organization.id] = project ? project.id : null;
  return {
    organizationId: organization.id,
    projectId: project ? project.id : null,
    projectIdsByOrganization,
  };
}

export function selectWorkspaceOrganization(context, selection, organizationId) {
  const organization = organizationById(context, boundedId(organizationId));
  if (!organization) return selection;
  const projectIdsByOrganization = { ...(selection.projectIdsByOrganization || {}) };
  const savedProjectId = boundedId(projectIdsByOrganization[organization.id]);
  const project = organization.projects.find((item) => item.id === savedProjectId)
    || organization.projects[0]
    || null;
  projectIdsByOrganization[organization.id] = project ? project.id : null;
  return {
    organizationId: organization.id,
    projectId: project ? project.id : null,
    projectIdsByOrganization,
  };
}

export function selectWorkspaceProject(context, selection, projectId) {
  const organization = organizationById(context, selection.organizationId);
  if (!organization) return selection;
  const project = organization.projects.find((item) => item.id === boundedId(projectId));
  if (!project) return selection;
  return {
    organizationId: organization.id,
    projectId: project.id,
    projectIdsByOrganization: {
      ...(selection.projectIdsByOrganization || {}),
      [organization.id]: project.id,
    },
  };
}
