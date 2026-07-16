import { api } from '../api.js';
import { setCurrentProject } from '../state.js';
import { el, clear, esc, toast, initials, loading, fmtPercent } from '../dom.js';

export async function renderBusiness(view) {
  view.append(loading('Loading businesses…'));
  const [{ businesses }, { projects }, settings] = await Promise.all([
    api.getBusinesses(),
    api.getProjects().catch(() => ({ projects: [] })),
    api.getSettings().catch(() => ({ repositoryProvider: 'github' })),
  ]);
  const repositoryProvider = settings.repositoryProvider === 'gitlab' ? 'gitlab' : 'github';

  clear(view).append(
    el('div', { class: 'page-head' }, [
      el('h1', {}, 'Businesses'),
      el('button', { class: 'primary', onclick: () => openBusinessModal(view, { projects, repositoryProvider }) }, '+ New Business'),
    ]),
    el('p', { class: 'muted', style: 'margin-top:-8px' }, 'Each business is backed by a Linear project. OTA is the initial business.')
  );

  if (!businesses.length) {
    view.append(el('div', { class: 'empty' }, [el('p', { class: 'muted' }, 'No businesses yet.')]));
    return;
  }

  const list = el('div', {});
  for (const b of businesses) {
    list.append(businessRow(b, projects, view, repositoryProvider));
  }
  view.append(list);
}

function businessRow(b, projects, view, repositoryProvider) {
  const linked = b.project;
  const linkInfo = linked
    ? el('div', { class: 'link-info' }, [
        `Linear project: ${linked.name} · ${fmtPercent(linked.progress)}% · `,
        el('span', { class: `badge state-${esc(linked.state || '')}` }, linked.state || ''),
      ])
    : el('div', { class: 'link-info' }, 'Not linked to a Linear project yet.');

  const openPlanning = el('button', {
    disabled: !b.projectId,
    onclick: () => {
      setCurrentProject(b.projectId);
      window.location.hash = `#/projects/${encodeURIComponent(b.projectId)}`;
    },
  }, 'Planning');

  const openBoard = el('button', {
    disabled: !b.projectId,
    onclick: () => {
      setCurrentProject(b.projectId);
      window.location.hash = '#/board';
    },
  }, 'Board');

  const edit = el('button', { onclick: () => openBusinessModal(view, { business: b, projects, repositoryProvider }) }, 'Edit');
  const del = el('button', {
    class: 'danger',
    onclick: async () => {
      if (!confirm(`Remove business "${b.name}"? (The Linear project is not deleted.)`)) return;
      try {
        await api.deleteBusiness(b.id);
        toast('Business removed.');
        renderBusiness(clear(view));
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, 'Remove');

  return el('div', { class: 'biz-row' }, [
    el('span', { class: 'avatar' }, initials(b.name)),
    el('div', {}, [
      el('div', { class: 'biz-name' }, b.name),
      linkInfo,
      b.repo ? el('div', { class: 'muted', style: 'font-size:12px' }, `${b.repoProvider === 'gitlab' ? 'GitLab' : 'GitHub'} · ${b.repo}`) : null,
      b.description ? el('div', { class: 'muted', style: 'font-size:12px' }, b.description) : null,
    ]),
    el('div', { class: 'actions' }, [openPlanning, openBoard, edit, del]),
  ]);
}

function openBusinessModal(view, { business = null, projects = [], repositoryProvider = 'github' }) {
  const isEdit = Boolean(business);
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  const nameInput = el('input', { value: business ? business.name : '', placeholder: 'e.g. OTA' });
  const descInput = el('textarea', { rows: '2', placeholder: 'Optional description' }, business ? business.description || '' : '');
  const selectedRepoProvider = business
    ? (business.repoProvider === 'gitlab' ? 'gitlab' : 'github')
    : repositoryProvider;
  const repoProviderSelect = el('select', { 'aria-label': 'Repository provider' }, [
    el('option', { value: 'github', selected: selectedRepoProvider !== 'gitlab' }, 'GitHub'),
    el('option', { value: 'gitlab', selected: selectedRepoProvider === 'gitlab' }, 'GitLab'),
  ]);
  const repoInput = el('input', {
    value: business ? business.repo || '' : '',
    'aria-label': 'Repository namespace or URL',
  });
  const repoHelp = el('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px' });
  const syncRepoFields = () => {
    const gitlab = repoProviderSelect.value === 'gitlab';
    repoInput.placeholder = gitlab ? 'group/subgroup/project' : 'owner/repository';
    repoHelp.textContent = gitlab
      ? 'GitLab namespace or official Git URL; nested groups are supported. Uses the saved GitLab token.'
      : 'GitHub owner/repository or official Git URL. Uses the saved GitHub token.';
  };
  repoProviderSelect.addEventListener('change', syncRepoFields);
  syncRepoFields();

  // Link mode: existing project, create new project, or none.
  const linkSelect = el('select', {}, [
    el('option', { value: 'existing' }, 'Link an existing Linear project'),
    el('option', { value: 'new' }, 'Create a new Linear project'),
    el('option', { value: 'none' }, 'No project (link later)'),
  ]);

  const projectSelect = el(
    'select',
    {},
    [el('option', { value: '' }, '— select a project —')].concat(
      projects.map((p) => el('option', { value: p.id, selected: business && business.projectId === p.id }, p.name))
    )
  );

  const teamSelect = el('select', {}, [el('option', { value: '' }, 'Loading teams…')]);
  const newProjectName = el('input', { placeholder: 'New project name (defaults to business name)' });

  const existingWrap = el('div', { class: 'field' }, [el('label', {}, 'Linear project'), projectSelect]);
  const newWrap = el('div', { style: 'display:none' }, [
    el('div', { class: 'field' }, [el('label', {}, 'Team'), teamSelect]),
    el('div', { class: 'field' }, [el('label', {}, 'Project name'), newProjectName]),
  ]);

  linkSelect.addEventListener('change', () => {
    const mode = linkSelect.value;
    existingWrap.style.display = mode === 'existing' ? '' : 'none';
    newWrap.style.display = mode === 'new' ? '' : 'none';
    if (mode === 'new' && teamSelect.options.length <= 1) loadTeams();
  });

  async function loadTeams() {
    try {
      const { teams } = await api.getTeams();
      clear(teamSelect).append(
        el('option', { value: '' }, '— select a team —'),
        ...teams.map((t) => el('option', { value: t.id }, `${t.name} (${t.key})`))
      );
    } catch (err) {
      clear(teamSelect).append(el('option', { value: '' }, `Failed to load teams: ${err.message}`));
    }
  }

  const saveBtn = el('button', { class: 'primary' }, isEdit ? 'Save' : 'Create');
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return toast('Name is required.', 'err');
    const mode = linkSelect.value;
    const payload = {
      name,
      description: descInput.value,
      repo: repoInput.value.trim(),
      repoProvider: repoProviderSelect.value,
    };

    if (mode === 'existing') payload.projectId = projectSelect.value || null;
    if (mode === 'new') {
      payload.createNewProject = true;
      payload.teamId = teamSelect.value;
      payload.projectName = newProjectName.value.trim() || name;
      if (!payload.teamId) return toast('Select a team for the new project.', 'err');
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (isEdit) await api.updateBusiness(business.id, payload);
      else await api.createBusiness(payload);
      toast(isEdit ? 'Business updated.' : 'Business created.', 'ok');
      close();
      renderBusiness(clear(view));
    } catch (err) {
      toast(err.message, 'err');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save' : 'Create';
    }
  });

  backdrop.append(
    el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, isEdit ? `Edit ${business.name}` : 'New Business'),
      el('div', { class: 'modal-body' }, [
        el('div', { class: 'field' }, [el('label', {}, 'Business name'), nameInput]),
        el('div', { class: 'field' }, [el('label', {}, 'Description'), descInput]),
        el('div', { class: 'field' }, [
          el('label', {}, 'Repository (for code generation)'),
          repoProviderSelect,
          repoInput,
          repoHelp,
        ]),
        el('div', { class: 'field' }, [el('label', {}, 'Project link'), linkSelect]),
        existingWrap,
        newWrap,
      ]),
      el('div', { class: 'modal-foot' }, [el('button', { onclick: close }, 'Cancel'), saveBtn]),
    ])
  );

  document.body.append(backdrop);
}
