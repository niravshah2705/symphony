import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';
import { setCurrentProject, setProjectSandbox } from '../state.js';
import {
  activeWorkspaceOrganization,
  activeWorkspaceProject,
  changeWorkspaceProject,
  getWorkspaceContext,
} from '../workspace-context.js';

async function loadProjectIntoOpenShell(project, { openChat = true } = {}) {
  const projectId = project?.id || '';
  const projectName = project?.name || projectId || 'default';
  setCurrentProject(projectId, projectName);
  try { changeWorkspaceProject(projectId); } catch (_) { /* personal projects may not be in org context */ }
  try {
    const res = await api.loadProjectSandbox({
      projectId,
      projectName,
      repositoryUrl: project?.repositoryUrl || '',
    });
    if (res && res.sandbox) {
      setProjectSandbox(projectId, res.sandbox);
      const gh = res.sandbox.secrets?.github?.configured ? 'GitHub ✓' : 'GitHub —';
      const or = res.sandbox.secrets?.openrouter?.configured ? 'OpenRouter ✓' : 'OpenRouter —';
      toast(`NVIDIA OpenShell sandbox ${res.sandbox.name} loaded (${gh}, ${or}).`, 'ok');
    }
  } catch (err) {
    toast(err.message || 'Could not load NVIDIA OpenShell sandbox.', 'err');
  }
  if (openChat) {
    window.location.hash = '#/agent';
  }
}

// Organization & projects view (org service via /api/org/*). Three tiers:
//   - Personal projects: any signed-in user, private, single-owner.
//   - Create organization: every user can create another collaborative tenant.
//   - Organization: selected-context projects, members, and people (ORG_ADMIN).
// The gateway + org service enforce every rule; this view is UX only.

function banner(message) {
  return el('div', { class: 'error-banner' }, message || 'Something went wrong.');
}

const PERSONAS = [
  { value: 'ENGINEER', label: 'Engineer', hint: 'You build and implement. Projects default to a developer role.' },
  { value: 'CLIENT', label: 'Client', hint: 'You brainstorm and review. Implementation is handled by your collaborators.' },
  { value: 'ORG_MANAGER', label: 'Org manager', hint: 'You manage the organization, its people, and projects.' },
];

function personaLabel(value) {
  return (PERSONAS.find((p) => p.value === value) || {}).label || value;
}

function pageHead() {
  return el('div', { class: 'page-head' }, [
    el('h1', {}, 'Organization & projects'),
    el('p', { class: 'muted' },
      'Create personal projects for private work. Create an organization to share projects and add people.'),
  ]);
}

function block(title, subtitle, children) {
  return el('section', { class: 'org-block' }, [
    el('div', { class: 'org-block-head' }, [
      el('h2', {}, title),
      subtitle ? el('p', { class: 'muted' }, subtitle) : null,
    ]),
    ...children,
  ]);
}

function projectRow(name, description, actions = [], onSelect = null) {
  const copy = el('div', {
    class: 'org-row-copy',
    style: onSelect ? 'cursor:pointer' : '',
    title: onSelect ? `Click to load NVIDIA OpenShell sandbox for ${name}` : '',
  }, [
    el('strong', {}, name),
    description ? el('small', { class: 'muted' }, description) : null,
  ]);
  if (typeof onSelect === 'function') {
    copy.addEventListener('click', onSelect);
  }
  return el('div', { class: 'org-row' }, [
    copy,
    actions.length ? el('div', { class: 'org-row-actions' }, actions) : null,
  ]);
}

// Small inline "name" creator: a text input + submit button wired to onCreate.
function createForm({ placeholder, submitLabel, onCreate, extra = [] }) {
  const name = el('input', { type: 'text', placeholder, 'aria-label': placeholder });
  const description = extra.includes('description')
    ? el('input', { type: 'text', placeholder: 'Description (optional)', 'aria-label': 'Description' })
    : null;
  const button = el('button', { class: 'primary', type: 'submit' }, submitLabel);
  const form = el('form', { class: 'org-form' }, [name, description, button].filter(Boolean));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = name.value.trim();
    if (!value) return;
    button.disabled = true;
    try {
      await onCreate({ name: value, description: description ? description.value.trim() || undefined : undefined });
    } catch (err) {
      toast(err.message || 'Request failed.');
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

async function renderPersonal(section, rerender) {
  let page;
  try {
    page = await api.org.listPersonalProjects();
  } catch (err) {
    section.replaceChildren(banner(err.message));
    return;
  }
  const projects = page.data || [];
  const rows = projects.length
    ? projects.map((project) => projectRow(project.name, project.description, [
        (() => {
          const openSb = el('button', { class: 'ghost', type: 'button' }, 'Open Sandbox Chat');
          openSb.addEventListener('click', () => {
            void loadProjectIntoOpenShell(project, { openChat: true });
          });
          return openSb;
        })(),
        (() => {
          const del = el('button', { class: 'ghost danger', type: 'button' }, 'Delete');
          del.addEventListener('click', async () => {
            del.disabled = true;
            try {
              await api.org.deletePersonalProject(project.id);
              await rerender();
            } catch (err) {
              toast(err.message || 'Could not delete the project.');
              del.disabled = false;
            }
          });
          return del;
        })(),
      ], () => void loadProjectIntoOpenShell(project, { openChat: true })))
    : [el('div', { class: 'empty compact-empty' }, [el('p', { class: 'muted' }, 'No personal projects yet.')])];

  // block() returns a <section>; move its content into the provided `section`.
  section.replaceChildren();
  section.append(...Array.from(block(
    'Personal projects',
    'Private to you. To add other people, create an organization below.',
    [
      createForm({
        placeholder: 'New personal project name',
        submitLabel: 'Create personal project',
        onCreate: async (payload) => {
          await api.org.createPersonalProject(payload);
          await rerender();
        },
      }),
      el('div', { class: 'org-list' }, rows),
    ],
  ).childNodes));
}

async function renderCreateOrg(section, { hasOrganizations }) {
  section.replaceChildren();
  section.append(...Array.from(block(
    hasOrganizations ? 'Create another organization' : 'Create an organization',
    hasOrganizations
      ? 'Start a separate organization. You will become its first administrator and can switch to it from the account menu.'
      : 'Personal projects stay private; create an organization to share projects and invite people.',
    [
      createForm({
        placeholder: 'Organization name',
        submitLabel: hasOrganizations ? 'Create another organization' : 'Create organization',
        extra: ['description'],
        onCreate: async (payload) => {
          await api.org.createOrganization(payload);
          toast('Organization created — you are now its admin.');
          // Context is a sign-in snapshot. A full reload re-fetches /me/context
          // so the new membership appears in the account switcher immediately.
          window.location.reload();
        },
      }),
    ],
  ).childNodes));
}

async function renderMembers(host, projectId, orgUsers, rerender) {
  let members = [];
  try {
    members = await api.org.listProjectMembers(projectId);
  } catch (err) {
    host.replaceChildren(banner(err.message));
    return;
  }
  const memberIds = new Set(members.map((m) => m.user_id || m.userId || m.id));
  const candidates = orgUsers.filter((u) => !memberIds.has(u.id));

  const rows = members.length
    ? members.map((m) => projectRow(m.email || m.full_name || m.user_id, `Role: ${m.role}`))
    : [el('p', { class: 'muted' }, 'No members yet.')];

  const select = el('select', { 'aria-label': 'Org user' },
    candidates.length
      ? candidates.map((u) => el('option', { value: u.id }, u.email || u.full_name || u.id))
      : [el('option', { value: '' }, 'No other org users — add people below')]);
  const roleSelect = el('select', { 'aria-label': 'Project role' }, [
    el('option', { value: 'DEVELOPER' }, 'Developer'),
    el('option', { value: 'TEAM_LEAD' }, 'Team lead'),
    el('option', { value: 'PROJECT_ADMIN' }, 'Project admin'),
  ]);
  const addBtn = el('button', { class: 'primary', type: 'submit' }, 'Add member');
  const addForm = el('form', { class: 'org-form' }, [select, roleSelect, addBtn]);
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!select.value) return;
    addBtn.disabled = true;
    try {
      await api.org.addProjectMember(projectId, { user_id: select.value, role: roleSelect.value });
      await rerender();
    } catch (err) {
      toast(err.message || 'Could not add member.');
      addBtn.disabled = false;
    }
  });

  host.replaceChildren(el('div', { class: 'org-members' }, [
    el('div', { class: 'org-list' }, rows),
    candidates.length ? addForm : el('p', { class: 'muted' }, 'Add people to the organization first (People section).'),
  ]));
}

// A segmented access-mode control for the active project (INVITE_ONLY vs
// ORG_WIDE). The org API validates the path project against the selected-project
// header, so this is only offered for the active project.
function accessModeControl(project) {
  const current = String(project.access_mode || 'INVITE_ONLY').toUpperCase();
  const select = el('select', { 'aria-label': 'Project access mode' }, [
    el('option', { value: 'INVITE_ONLY' }, 'Invite only'),
    el('option', { value: 'ORG_WIDE' }, 'Everyone in the org'),
  ]);
  select.value = current === 'ORG_WIDE' ? 'ORG_WIDE' : 'INVITE_ONLY';
  select.addEventListener('change', async () => {
    const next = select.value;
    select.disabled = true;
    try {
      await api.org.setProjectAccessMode(project.id, next);
      toast(next === 'ORG_WIDE'
        ? 'Every organization member can now access this project.'
        : 'This project is now invite-only.');
    } catch (err) {
      toast(err.message || 'Could not change access mode.');
      select.value = current === 'ORG_WIDE' ? 'ORG_WIDE' : 'INVITE_ONLY';
    } finally {
      select.disabled = false;
    }
  });
  return el('label', { class: 'org-inline-field' }, [el('span', { class: 'muted' }, 'Access'), select]);
}

// Invite a single outside-domain person (e.g. a freelance engineer's personal
// email) to just this project.
async function renderProjectInvitations(host, projectId, defaultRole) {
  // Refresh THIS panel in place (not the whole view) so it stays open and shows
  // the change immediately.
  const reload = () => renderProjectInvitations(host, projectId, defaultRole);
  let invitations = [];
  try {
    invitations = await api.org.listProjectInvitations(projectId);
  } catch (err) {
    host.replaceChildren(banner(err.message));
    return;
  }
  const pending = (Array.isArray(invitations) ? invitations : invitations.data || [])
    .filter((invite) => (invite.status || 'PENDING') === 'PENDING');
  const rows = pending.length
    ? pending.map((invite) => {
        const revoke = el('button', { class: 'ghost danger', type: 'button' }, 'Revoke');
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try {
            await api.org.revokeProjectInvitation(projectId, invite.id);
            toast('Invitation revoked.');
            await reload();
          } catch (err) {
            toast(err.message || 'Could not revoke.');
            revoke.disabled = false;
          }
        });
        return projectRow(invite.email, `Pending · Role: ${invite.role || 'DEVELOPER'}`, invite.id ? [revoke] : []);
      })
    : [el('p', { class: 'muted' }, 'No outside collaborators invited yet.')];

  const email = el('input', { type: 'email', placeholder: 'person@example.com', 'aria-label': 'Collaborator email' });
  const role = el('select', { 'aria-label': 'Project role' }, [
    el('option', { value: 'DEVELOPER' }, 'Developer'),
    el('option', { value: 'TEAM_LEAD' }, 'Team lead'),
    el('option', { value: 'PROJECT_ADMIN' }, 'Project admin'),
  ]);
  role.value = defaultRole || 'DEVELOPER';
  const addBtn = el('button', { class: 'primary', type: 'submit' }, 'Invite collaborator');
  const form = el('form', { class: 'org-form org-form-wide' }, [email, role, addBtn]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!email.value.trim()) return;
    addBtn.disabled = true;
    try {
      const delivery = await api.org.createProjectInvitation(projectId, {
        email: email.value.trim(), role: role.value,
      });
      toast(delivery?.delivery_status === 'failed'
        ? 'Invitation saved, but its email could not be queued.'
        : 'Invitation email queued. They join this project after accepting it.');
      await reload();
    } catch (err) {
      toast(err.message || 'Could not send the invitation.');
      addBtn.disabled = false;
    }
  });

  host.replaceChildren(el('div', { class: 'org-members' }, [el('div', { class: 'org-list' }, rows), form]));
}

// Grant a whole partner organization access to this project (outsourcing). The
// org service rejects PROJECT_ADMIN for a whole-org grant, so it is omitted here.
async function renderExternalGrants(host, projectId) {
  const reload = () => renderExternalGrants(host, projectId);
  let grants = [];
  try {
    grants = await api.org.listExternalGrants(projectId);
  } catch (err) {
    host.replaceChildren(banner(err.message));
    return;
  }
  const list = Array.isArray(grants) ? grants : grants.data || [];
  const rows = list.length
    ? list.map((grant) => {
        const revoke = el('button', { class: 'ghost danger', type: 'button' }, 'Revoke');
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try {
            await api.org.revokeExternalGrant(projectId, grant.collaborator_org_id);
            toast('Partner access revoked.');
            await reload();
          } catch (err) {
            toast(err.message || 'Could not revoke.');
            revoke.disabled = false;
          }
        });
        return projectRow(
          grant.collaborator_org_id,
          `Partner org · Default role: ${grant.default_role || 'DEVELOPER'}`,
          [revoke],
        );
      })
    : [el('p', { class: 'muted' }, 'No partner organizations have access.')];

  const orgId = el('input', { type: 'text', placeholder: 'Partner organization ID', 'aria-label': 'Collaborator organization ID' });
  const role = el('select', { 'aria-label': 'Default role for partner members' }, [
    el('option', { value: 'DEVELOPER' }, 'Developer'),
    el('option', { value: 'TEAM_LEAD' }, 'Team lead'),
  ]);
  const addBtn = el('button', { class: 'primary', type: 'submit' }, 'Grant access');
  const form = el('form', { class: 'org-form org-form-wide' }, [orgId, role, addBtn]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!orgId.value.trim()) return;
    addBtn.disabled = true;
    try {
      await api.org.createExternalGrant(projectId, {
        collaborator_org_id: orgId.value.trim(), default_role: role.value,
      });
      toast('Partner organization granted access.');
      await reload();
    } catch (err) {
      toast(err.message || 'Could not grant access.');
      addBtn.disabled = false;
    }
  });

  host.replaceChildren(el('div', { class: 'org-members' }, [
    el('div', { class: 'org-list' }, rows),
    el('p', { class: 'muted' }, 'Every member of the partner organization gets access with the default role.'),
    form,
  ]));
}

// A labelled collapsible panel button that lazy-renders its body on first open.
function collapsiblePanel(label, host, loadBody) {
  const toggle = el('button', { class: 'ghost', type: 'button' }, label);
  let open = false;
  toggle.addEventListener('click', async () => {
    open = !open;
    if (!open) { host.replaceChildren(); return; }
    host.replaceChildren(loading(`Loading ${label.toLowerCase()}…`));
    await loadBody(host);
  });
  return toggle;
}

async function renderOrgProjects(section, organization, orgUsers, rerender) {
  const isAdmin = String(organization.role || '').toUpperCase() === 'ORG_ADMIN';
  const activeProjectId = activeWorkspaceProject(getWorkspaceContext())?.id || null;
  let page;
  try {
    page = await api.org.listOrgProjects();
  } catch (err) {
    section.replaceChildren(banner(err.message));
    return;
  }
  const persona = String(getWorkspaceContext().user?.persona || '').toUpperCase();
  // Engineers default new collaborators to a developer role; others to developer too
  // (least surprising) — clients rarely add implementers directly.
  const defaultCollaboratorRole = persona === 'CLIENT' ? 'TEAM_LEAD' : 'DEVELOPER';
  const projects = page.data || [];
  const rows = projects.length
    ? projects.map((project) => {
        const contextProject = organization.projects.find((item) => item.id === project.id);
        // The org API validates the path project against the top selection.
        // Never offer a sibling-project action that would (correctly) 404.
        const canManage = project.id === activeProjectId
          && (isAdmin || String(contextProject?.role || '').toUpperCase() === 'PROJECT_ADMIN');
        const membersHost = el('div', { class: 'org-members-host' });
        const collaboratorsHost = el('div', { class: 'org-members-host' });
        const outsourceHost = el('div', { class: 'org-members-host' });

        const openSbBtn = el('button', { class: 'ghost', type: 'button' }, 'Open Sandbox Chat');
        openSbBtn.addEventListener('click', () => {
          void loadProjectIntoOpenShell(project, { openChat: true });
        });
        const actions = [openSbBtn];
        if (canManage) {
          actions.push(accessModeControl(project));
          actions.push(collapsiblePanel('Members', membersHost,
            (host) => renderMembers(host, project.id, orgUsers, rerender)));
          actions.push(collapsiblePanel('Collaborators', collaboratorsHost,
            (host) => renderProjectInvitations(host, project.id, defaultCollaboratorRole)));
          actions.push(collapsiblePanel('Outsource', outsourceHost,
            (host) => renderExternalGrants(host, project.id)));
        }
        const accessBadge = String(project.access_mode || '').toUpperCase() === 'ORG_WIDE'
          ? el('span', { class: 'badge' }, 'Org-wide')
          : null;
        const rawTags = project.tags || contextProject?.tags || [];
        const tagBadges = (Array.isArray(rawTags) ? rawTags : []).map((tag) =>
          el('span', { class: 'badge sm' }, typeof tag === 'string' ? tag : tag.name || tag.id || '')
        );
        return el('div', { class: 'org-row-group' }, [
          projectRow(
            project.name,
            project.description,
            [...tagBadges, ...(accessBadge ? [accessBadge] : []), ...actions],
            () => void loadProjectIntoOpenShell(project, { openChat: true }),
          ),
          membersHost,
          collaboratorsHost,
          outsourceHost,
        ]);
      })
    : [el('div', { class: 'empty compact-empty' }, [el('p', { class: 'muted' }, 'No organization projects yet.')])];

  const children = [];
  if (isAdmin) {
    children.push(createForm({
      placeholder: 'New organization project name',
      submitLabel: 'Create org project',
      onCreate: async (payload) => {
        await api.org.createOrgProject(payload);
        // The account project picker is backed by /me/context, not this view's
        // project list. Reload so the newly created project is selectable.
        window.location.reload();
      },
    }));
  }
  children.push(el('div', { class: 'org-list' }, rows));

  section.replaceChildren();
  section.append(...Array.from(block('Organization projects',
    isAdmin ? 'Shared across the organization. Add members from your org’s people.' : 'Projects you are a member of.',
    children).childNodes));
}

async function renderPeople(section, rerender) {
  let page;
  let invitationPage;
  try {
    [page, invitationPage] = await Promise.all([
      api.org.listOrgUsers(),
      api.org.listInvitations(),
    ]);
  } catch (err) {
    section.replaceChildren(banner(err.message));
    return;
  }
  const users = page.data || [];
  const invitations = Array.isArray(invitationPage)
    ? invitationPage
    : invitationPage.data || invitationPage.invitations || [];
  const rows = users.length
    ? users.map((u) => projectRow(u.email || u.full_name || u.id, `Role: ${u.org_role || 'MEMBER'}`))
    : [el('p', { class: 'muted' }, 'Just you so far.')];

  const pendingInvitations = invitations.filter((invitation) => invitation.status === 'PENDING');
  const invitationRows = pendingInvitations.length
    ? pendingInvitations.map((invitation) => {
        const invitationId = invitation.id || invitation.invitation_id;
        const resend = el('button', { class: 'ghost', type: 'button' }, 'Resend');
        const revoke = el('button', { class: 'ghost danger', type: 'button' }, 'Revoke');
        resend.addEventListener('click', async () => {
          resend.disabled = true;
          try {
            const delivery = await api.org.resendInvitation(invitationId);
            toast(delivery?.delivery_status === 'failed'
              ? 'Invitation saved, but its email could not be queued. Try resending shortly.'
              : 'Invitation email queued again.');
          } catch (err) {
            toast(err.message || 'Could not resend the invitation.');
          } finally {
            resend.disabled = false;
          }
        });
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try {
            await api.org.revokeInvitation(invitationId);
            toast('Invitation revoked.');
            await rerender();
          } catch (err) {
            toast(err.message || 'Could not revoke the invitation.');
            revoke.disabled = false;
          }
        });
        return projectRow(
          invitation.email || 'Pending invitation',
          `Pending invitation · Role: ${invitation.org_role || invitation.role || 'MEMBER'}`,
          invitationId ? [resend, revoke] : []
        );
      })
    : [el('p', { class: 'muted' }, 'No pending invitations.')];

  const email = el('input', { type: 'email', placeholder: 'person@company.com', 'aria-label': 'Email' });
  const role = el('select', { 'aria-label': 'Org role' }, [
    el('option', { value: 'MEMBER' }, 'Member'),
    el('option', { value: 'ORG_ADMIN' }, 'Org admin'),
  ]);
  const addBtn = el('button', { class: 'primary', type: 'submit' }, 'Send invitation');
  const form = el('form', { class: 'org-form org-form-wide' }, [email, role, addBtn]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!email.value.trim()) return;
    addBtn.disabled = true;
    try {
      const delivery = await api.org.createInvitation({
        email: email.value.trim(),
        org_role: role.value,
      });
      toast(delivery?.delivery_status === 'failed'
        ? 'Invitation saved, but its email could not be queued. You can resend it below.'
        : 'Invitation email queued. They will join only after accepting it.');
      await rerender();
    } catch (err) {
      toast(err.message || 'Could not send the invitation.');
      addBtn.disabled = false;
    }
  });

  section.replaceChildren();
  section.append(...Array.from(block('People',
    'Invite people by email. They become members only after accepting the invitation.',
    [
      form,
      el('div', { class: 'org-list' }, rows),
      el('h3', {}, 'Pending invitations'),
      el('div', { class: 'org-list', dataset: { invitationList: 'true' } }, invitationRows),
    ]).childNodes));
}

async function renderOrg(section, organization, rerender) {
  if (!organization) {
    section.replaceChildren(el('div', { class: 'empty compact-empty' }, [
      el('p', { class: 'muted' }, 'No organization is selected yet.'),
    ]));
    return;
  }
  let org;
  try {
    org = await api.org.getCurrentOrganization();
  } catch (err) {
    section.replaceChildren(banner(err.message));
    return;
  }
  const isAdmin = String(organization.role || '').toUpperCase() === 'ORG_ADMIN';
  const hasProjectAdminRole = organization.projects.some(
    (project) => String(project.role || '').toUpperCase() === 'PROJECT_ADMIN'
  );
  const orgRawTags = org.tags || organization.tags || [];
  const orgTagBadges = (Array.isArray(orgRawTags) ? orgRawTags : []).map((tag) =>
    el('span', { class: 'badge sm' }, typeof tag === 'string' ? tag : tag.name || tag.id || '')
  );
  const header = el('div', { class: 'org-block-head' }, [
    el('div', { class: 'org-block-head-title' }, [
      el('h2', {}, org.name || organization.name || 'Your organization'),
      ...orgTagBadges,
    ]),
    el('p', { class: 'muted' }, `Your role: ${organization.role || 'MEMBER'}${org.description ? ` · ${org.description}` : ''}`),
  ]);

  const projectsSection = el('section', { class: 'org-block' });
  const billingSection = el('section', { class: 'org-block' });
  const peopleSection = isAdmin ? el('section', { class: 'org-block' }) : null;
  section.replaceChildren(header, projectsSection, billingSection, ...(peopleSection ? [peopleSection] : []));

  // People must load first so the members picker has candidates.
  const orgUsers = isAdmin || hasProjectAdminRole
    ? await api.org.listOrgUsers().then((p) => p.data || []).catch(() => [])
    : [];
  await renderOrgProjects(projectsSection, organization, orgUsers, rerender);
  await renderOrgBilling(billingSection, organization, isAdmin);
  if (peopleSection) await renderPeople(peopleSection, rerender);
}

// Self-declared persona capture (asked once at onboarding). Descriptive only —
// it does not gate access (roles do); it tailors UI defaults/copy.
function loadCashfreeSdk() {
  if (window.Cashfree) return Promise.resolve(window.Cashfree);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    script.onload = () => resolve(window.Cashfree);
    script.onerror = () => reject(new Error('Failed to load Cashfree Checkout SDK'));
    document.head.appendChild(script);
  });
}

async function renderOrgBilling(section, organization, isAdmin) {
  const reload = () => renderOrgBilling(section, organization, isAdmin);
  let summary;
  try {
    summary = await api.billing.getSummary();
  } catch (err) {
    section.replaceChildren(el('div', { class: 'empty compact-empty' }, [
      el('p', { class: 'muted' }, (err && err.message) || 'Billing details currently unavailable.'),
    ]));
    return;
  }

  const inr = (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(val) || 0);
  const isAvailable = summary.fundStatus !== 'unavailable' && Number(summary.balancePaise) > 0;
  const statusBadge = el('span', { class: `badge ${isAvailable ? 'active' : 'warn'}` }, isAvailable ? 'Funds Available' : 'Funds Unavailable');
  const ar = summary.autoRecharge || {};
  const isAutoEnabled = Boolean(ar.enabled);
  const currentMode = ar.mode || 'amount';

  const rows = [
    el('div', { class: 'org-row' }, [
      el('div', { class: 'org-row-copy' }, [
        el('strong', {}, 'Current Balance'),
        el('small', { class: 'muted' }, `Seeded credit: ${inr(summary.initialCreditInr)} · Sandbox creation: ${summary.sandboxCreationDisabled ? 'Disabled (Low Balance)' : 'Enabled'}`),
      ]),
      el('div', { class: 'org-row-actions' }, [
        el('span', { class: 'cost-cell', style: 'font-size: 16px; margin-right: 8px;' }, inr(summary.balanceInr)),
        statusBadge,
      ]),
    ]),
  ];

  if (!isAvailable) {
    rows.push(el('div', { class: 'notice operational-notice operational-notice-warn', style: 'margin-top: 10px;' }, [
      el('strong', {}, 'Account Low / Negative: '),
      el('span', {}, 'Sandbox creation and scheduled calls are paused until payment is added or auto-renew triggers.'),
    ]));
  }

  if (isAdmin) {
    // Payment Mandate row
    const hasSub = Boolean(ar.cashfreeSubscriptionId);
    const subBadge = el('span', { class: `status-pill ${hasSub ? 'ok' : 'neutral'}` }, hasSub ? `Active Mandate: ${ar.cashfreeSubscriptionId}` : 'No Mandate Configured');
    const authBtn = el('button', { type: 'button', class: 'primary' }, 'Authorize Payment Mandate (UPI / Card / eNACH)');

    authBtn.addEventListener('click', async () => {
      authBtn.disabled = true;
      try {
        const res = await api.billing.createCashfreeMandate({
          returnUrl: window.location.href,
        });
        if (!res.subscriptionSessionId) {
          throw new Error('Did not receive subscription session ID from Cashfree.');
        }
        toast('Opening Cashfree Payment Authorization…');
        const CashfreeSdk = await loadCashfreeSdk();
        const cashfree = CashfreeSdk({ mode: 'sandbox' });

        cashfree.subscriptionsCheckout({
          subsSessionId: res.subscriptionSessionId,
          redirectTarget: '_blank',
        }).then(async (result) => {
          if (result && result.error) {
            toast(`Authorization error: ${result.error.message}`);
            authBtn.disabled = false;
          } else {
            toast('Verifying mandate authorization…');
            await api.billing.verifyCashfreeMandate(res.subscriptionId);
            await reload();
          }
        }).catch((err) => {
          toast((err && err.message) || 'Checkout window closed or failed');
          authBtn.disabled = false;
        });
      } catch (err) {
        toast((err && err.message) || 'Failed to initialize Cashfree mandate');
        authBtn.disabled = false;
      }
    });

    rows.push(el('div', { class: 'org-row' }, [
      el('div', { class: 'org-row-copy' }, [
        el('strong', {}, 'Payment Mandate & Auto-Charge'),
        el('small', { class: 'muted' }, 'Authorize recurring debit via Cashfree for automatic balance replenishment.'),
      ]),
      el('div', { class: 'org-row-actions' }, [subBadge, authBtn]),
    ]));

    // Auto-reload configuration form
    const arCheckbox = el('input', { type: 'checkbox', ...(isAutoEnabled ? { checked: 'checked' } : {}) });
    const modeAmountRadio = el('input', { type: 'radio', name: 'orgArMode', value: 'amount', ...(currentMode === 'amount' ? { checked: 'checked' } : {}) });
    const modePercentRadio = el('input', { type: 'radio', name: 'orgArMode', value: 'percentage', ...(currentMode === 'percentage' ? { checked: 'checked' } : {}) });

    const thresholdAmountInput = el('input', { type: 'number', min: '0', step: '10', value: String(ar.thresholdInr ?? 0) });
    const thresholdPercentInput = el('input', { type: 'number', min: '1', max: '100', step: '1', value: String(ar.thresholdPercent ?? 20) });
    const reloadAmountInput = el('input', { type: 'number', min: '100', step: '100', value: String(ar.amountInr ?? 500) });

    const amountField = el('label', { class: 'org-inline-field', id: 'org-ar-amount-field' }, [
      el('span', { class: 'muted' }, 'Threshold Amount (INR)'),
      thresholdAmountInput,
    ]);
    const percentField = el('label', { class: 'org-inline-field', id: 'org-ar-percent-field' }, [
      el('span', { class: 'muted' }, 'Threshold (% of Credit)'),
      thresholdPercentInput,
    ]);

    const updateVisibility = () => {
      amountField.style.display = modeAmountRadio.checked ? 'flex' : 'none';
      percentField.style.display = modePercentRadio.checked ? 'flex' : 'none';
    };
    modeAmountRadio.addEventListener('change', updateVisibility);
    modePercentRadio.addEventListener('change', updateVisibility);
    updateVisibility();

    const saveConfigBtn = el('button', { type: 'submit', class: 'primary' }, 'Save Auto-Renew Settings');
    const configForm = el('form', { class: 'org-form org-form-wide', style: 'display: grid; gap: 12px; margin-top: 10px;' }, [
      el('label', { class: 'radio-label', style: 'display: flex; align-items: center; gap: 8px;' }, [
        arCheckbox,
        el('strong', {}, 'Enable Auto-Reload for this Organization'),
      ]),
      el('div', { style: 'display: flex; gap: 16px; align-items: center;' }, [
        el('label', { class: 'radio-label', style: 'display: flex; align-items: center; gap: 6px;' }, [
          modeAmountRadio,
          el('span', {}, 'Fixed Amount (INR)'),
        ]),
        el('label', { class: 'radio-label', style: 'display: flex; align-items: center; gap: 6px;' }, [
          modePercentRadio,
          el('span', {}, 'Percentage of Credit (%)'),
        ]),
      ]),
      el('div', { style: 'display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap;' }, [
        amountField,
        percentField,
        el('label', { class: 'org-inline-field' }, [
          el('span', { class: 'muted' }, 'Reload Amount (INR)'),
          reloadAmountInput,
        ]),
        saveConfigBtn,
      ]),
    ]);

    configForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      saveConfigBtn.disabled = true;
      try {
        await api.billing.updateConfig({
          autoRecharge: {
            enabled: arCheckbox.checked,
            mode: modePercentRadio.checked ? 'percentage' : 'amount',
            thresholdInr: Number(thresholdAmountInput.value) || 0,
            thresholdPercent: Number(thresholdPercentInput.value) || 20,
            amountInr: Number(reloadAmountInput.value) || 0,
          },
        });
        toast('Organization billing settings saved.');
        await reload();
      } catch (err) {
        toast((err && err.message) || 'Failed to save billing settings.');
        saveConfigBtn.disabled = false;
      }
    });

    rows.push(el('div', { class: 'org-row-group', style: 'margin-top: 12px;' }, [
      el('strong', {}, 'Configure Auto-Reload Policy'),
      configForm,
    ]));
  }

  section.replaceChildren();
  section.append(...Array.from(block('Organization Payment & Billing',
    isAdmin ? 'Manage fund availability, payment mandates, and auto-renew thresholds for your organisation.' : 'View organisation balance and fund status.',
    rows).childNodes));
}

async function renderPersona(section, workspace, rerender) {
  const current = workspace.user?.persona || null;
  const children = [];

  if (!current) {
    children.push(el('p', { class: 'muted' }, 'Tell us how you plan to use AI Fleet so we can tailor your workspace.'));
    const choices = el('div', { class: 'org-row-actions' }, PERSONAS.map((persona) => {
      const btn = el('button', { class: 'ghost', type: 'button' }, persona.label);
      btn.addEventListener('click', async () => {
        choices.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          await api.org.setPersona(persona.value);
          toast(`Set up as ${persona.label}.`);
          // Persona rides on /me/context (a sign-in snapshot); reload so the rest
          // of the workspace sees it.
          window.location.reload();
        } catch (err) {
          toast(err.message || 'Could not save your selection.');
          choices.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        }
      });
      return btn;
    }));
    children.push(choices);
  } else {
    const info = PERSONAS.find((p) => p.value === current);
    children.push(el('p', { class: 'muted' }, [
      'You are set up as ',
      el('strong', {}, personaLabel(current)),
      info ? `. ${info.hint}` : '.',
    ]));
    if (current === 'CLIENT') {
      children.push(el('div', { class: 'empty compact-empty' }, [
        el('p', { class: 'muted' },
          'Brainstorm-only: implementation actions are performed by the engineers you collaborate with.'),
      ]));
    }
  }

  section.replaceChildren();
  section.append(...Array.from(block(
    current ? 'Your role' : 'Welcome — pick your role',
    null,
    children,
  ).childNodes));
}

// Surface pending org/project invitations addressed to the signed-in email.
// Surfacing only: acceptance uses the emailed single-use link, so we point the
// user to their email rather than exposing a token here.
async function renderPendingInvitations(section) {
  let pending = [];
  try {
    pending = await api.org.listPendingInvitations();
  } catch (_) {
    section.replaceChildren();
    return; // best-effort surfacing — never block the page on it
  }
  if (!Array.isArray(pending) || pending.length === 0) {
    section.replaceChildren();
    return;
  }
  const rows = pending.map((invite) => {
    const scope = invite.kind === 'project'
      ? `Project “${invite.project_name || invite.project_id}”`
      : `Organization “${invite.organization_name || invite.organization_id}”`;
    return projectRow(scope, `Pending invitation · Role: ${invite.role || 'MEMBER'}`);
  });
  section.replaceChildren();
  section.append(...Array.from(block(
    'You have pending invitations',
    'Check your email for the invitation link to accept. Accepting adds you to that workspace.',
    [el('div', { class: 'org-list' }, rows)],
  ).childNodes));
}

export async function renderOrganization(view) {
  clear(view).append(loading('Loading your workspace…'));
  const rerender = () => renderOrganization(view);

  let me;
  try {
    me = await api.org.getMe();
  } catch (err) {
    clear(view).append(pageHead(), banner(err.message || 'Sign in to manage projects and organizations.'));
    return;
  }

  const personaSection = el('section', { class: 'org-block' });
  const pendingSection = el('section', { class: 'org-block' });
  const personalSection = el('section', { class: 'org-block' });
  const orgSection = el('section', { class: 'org-block' });
  const createOrgSection = el('section', { class: 'org-block' });
  const workspace = getWorkspaceContext();
  const organization = activeWorkspaceOrganization(workspace);
  clear(view).append(
    pageHead(), personaSection, pendingSection, personalSection, orgSection, createOrgSection,
  );

  await Promise.all([
    renderPersona(personaSection, workspace, rerender),
    renderPendingInvitations(pendingSection),
    renderPersonal(personalSection, rerender),
    renderOrg(orgSection, organization, rerender),
    renderCreateOrg(createOrgSection, { hasOrganizations: workspace.organizations.length > 0 }),
  ]);
}
