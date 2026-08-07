import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';

// Organization & projects view (org service via /api/org/*). Three tiers:
//   - Personal projects: any signed-in user, private, single-owner.
//   - Create organization: the org-less path to collaboration.
//   - Organization: org projects, members, and people (ORG_ADMIN).
// The gateway + org service enforce every rule; this view is UX only.

function banner(message) {
  return el('div', { class: 'error-banner' }, message || 'Something went wrong.');
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

function projectRow(name, description, actions = []) {
  return el('div', { class: 'org-row' }, [
    el('div', { class: 'org-row-copy' }, [
      el('strong', {}, name),
      description ? el('small', { class: 'muted' }, description) : null,
    ]),
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
      ]))
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

async function renderCreateOrg(section, rerender) {
  section.replaceChildren();
  section.append(...Array.from(block(
    'Create an organization',
    'You are not part of an organization. Personal projects stay private; create an organization to share projects and invite people.',
    [
      createForm({
        placeholder: 'Organization name',
        submitLabel: 'Create organization',
        extra: ['description'],
        onCreate: async (payload) => {
          await api.org.createOrganization(payload);
          toast('Organization created — you are now its admin.');
          await rerender();
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

async function renderOrgProjects(section, me, orgUsers, rerender) {
  const isAdmin = me.org_role === 'ORG_ADMIN';
  let page;
  try {
    page = await api.org.listOrgProjects();
  } catch (err) {
    section.replaceChildren(banner(err.message));
    return;
  }
  const projects = page.data || [];
  const rows = projects.length
    ? projects.map((project) => {
        const membersHost = el('div', { class: 'org-members-host' });
        const toggle = el('button', { class: 'ghost', type: 'button' }, 'Members');
        let open = false;
        toggle.addEventListener('click', async () => {
          open = !open;
          if (!open) { membersHost.replaceChildren(); return; }
          membersHost.replaceChildren(loading('Loading members…'));
          await renderMembers(membersHost, project.id, orgUsers, rerender);
        });
        return el('div', { class: 'org-row-group' }, [
          projectRow(project.name, project.description, isAdmin ? [toggle] : []),
          membersHost,
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
        await rerender();
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
  try {
    page = await api.org.listOrgUsers();
  } catch (err) {
    section.replaceChildren(banner(err.message));
    return;
  }
  const users = page.data || [];
  const rows = users.length
    ? users.map((u) => projectRow(u.email || u.full_name || u.id, `Role: ${u.org_role || 'MEMBER'}`))
    : [el('p', { class: 'muted' }, 'Just you so far.')];

  const email = el('input', { type: 'email', placeholder: 'person@company.com', 'aria-label': 'Email' });
  const fullName = el('input', { type: 'text', placeholder: 'Full name (optional)', 'aria-label': 'Full name' });
  const password = el('input', { type: 'password', placeholder: 'Temporary password (min 8)', 'aria-label': 'Temporary password' });
  const role = el('select', { 'aria-label': 'Org role' }, [
    el('option', { value: 'MEMBER' }, 'Member'),
    el('option', { value: 'ORG_ADMIN' }, 'Org admin'),
  ]);
  const addBtn = el('button', { class: 'primary', type: 'submit' }, 'Add person');
  const form = el('form', { class: 'org-form org-form-wide' }, [email, fullName, password, role, addBtn]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!email.value.trim() || password.value.length < 8) {
      toast('Enter an email and a temporary password of at least 8 characters.');
      return;
    }
    addBtn.disabled = true;
    try {
      await api.org.createOrgUser({
        email: email.value.trim(),
        full_name: fullName.value.trim() || undefined,
        password: password.value,
        org_role: role.value,
      });
      toast('Person added to your organization.');
      await rerender();
    } catch (err) {
      toast(err.message || 'Could not add the person.');
      addBtn.disabled = false;
    }
  });

  section.replaceChildren();
  section.append(...Array.from(block('People',
    'Add people to your organization, then add them to projects as members.',
    [form, el('div', { class: 'org-list' }, rows)]).childNodes));
}

async function renderOrg(section, me, rerender) {
  if (!me.has_organization) {
    await renderCreateOrg(section, rerender);
    return;
  }
  let org;
  try {
    org = await api.org.getCurrentOrganization();
  } catch (err) {
    section.replaceChildren(banner(err.message));
    return;
  }
  const isAdmin = me.org_role === 'ORG_ADMIN';
  const header = el('div', { class: 'org-block-head' }, [
    el('h2', {}, org.name || 'Your organization'),
    el('p', { class: 'muted' }, `Your role: ${me.org_role}${org.description ? ` · ${org.description}` : ''}`),
  ]);

  const projectsSection = el('section', { class: 'org-block' });
  const peopleSection = isAdmin ? el('section', { class: 'org-block' }) : null;
  section.replaceChildren(header, projectsSection, ...(peopleSection ? [peopleSection] : []));

  // People must load first so the members picker has candidates.
  const orgUsers = isAdmin
    ? await api.org.listOrgUsers().then((p) => p.data || []).catch(() => [])
    : [];
  await renderOrgProjects(projectsSection, me, orgUsers, rerender);
  if (peopleSection) await renderPeople(peopleSection, rerender);
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

  const personalSection = el('section', { class: 'org-block' });
  const orgSection = el('section', { class: 'org-block' });
  clear(view).append(pageHead(), personalSection, orgSection);

  await Promise.all([
    renderPersonal(personalSection, rerender),
    renderOrg(orgSection, me, rerender),
  ]);
}
