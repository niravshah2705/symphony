import { api } from '../api.js';
import { el, clear, toast, loading } from '../dom.js';

export async function renderSettings(view) {
  view.append(loading('Loading settings…'));

  const [settings, presets, configRes, modelsRes, labelsRes, membersRes, roleRes, codexRes, claudeRes] = await Promise.all([
    api.getSettings(),
    api.getLlmPresets(),
    api.getAgentConfig(),
    api.getAgentModels(),
    api.getAgentLabels().catch(() => ({ labels: [] })),
    api.getMembers().catch(() => ({ members: [] })),
    api.getAssumedRole().catch(() => ({ assumedRole: null })),
    api.getCodexStatus().catch(() => ({ connected: false })),
    api.getClaudeStatus().catch(() => ({ connected: false })),
  ]);

  // Older stores intentionally kept hosted model ids blank and relied on the
  // provider defaults. Seed those effective ids into the in-memory public view
  // so the dropdown reflects today's provider default rather than a stale UI
  // fallback. Nothing is persisted until the operator changes a selection.
  if (!settings.codexModel) settings.codexModel = codexRes.model || codexRes.defaultModel || 'gpt-5.6-sol';
  if (!settings.claudeModel) settings.claudeModel = claudeRes.model || claudeRes.defaultModel || 'claude-opus-4-8';

  const llm = llmSection({
    settings,
    presets,
    discovery: Object.create(null),
    selectionPending: Object.create(null),
    codex: codexRes,
    claude: claudeRes,
    view,
  });
  const groups = [
    settingsGroup('settings-models', 'Models & runtime', 'Choose where work runs and how agents coordinate.', [
      llm,
      runtimeSection({ settings, codex: codexRes, claude: claudeRes }),
    ]),
    settingsGroup('settings-connections', 'Connections', 'Connect planning, source control, and observability services.', [
      integrationsSection(settings),
      keysSection(settings),
    ]),
    settingsGroup('settings-automation', 'Automation', 'Control schedules, limits, and automatic outputs.', [
      agentSection({
        config: configRes.config,
        intervals: modelsRes.intervals || [5, 10, 15],
        labels: labelsRes.labels || [],
        view,
      }),
    ]),
    settingsGroup('settings-identity', 'Identity', 'Choose the workspace member used for owned actions.', [
      roleSection({ members: membersRes.members || [], assumedRole: roleRes.assumedRole, view }),
    ]),
  ];

  clear(view).append(
    el('header', { class: 'page-head settings-page-head' }, [
      el('div', {}, [
        el('span', { class: 'settings-eyebrow' }, 'Workspace configuration'),
        el('h1', {}, 'Settings'),
        el('p', { class: 'muted settings-page-intro' }, 'Set up models and connections first, then tune runtime and automation only when you need to.'),
      ]),
    ]),
    settingsOverview({ settings, codex: codexRes, claude: claudeRes }),
    el('div', { class: 'settings-layout' }, [
      settingsIndex(),
      el('div', { class: 'settings-content' }, groups),
    ])
  );
}

function settingsIndex() {
  return el('nav', { class: 'settings-index', 'aria-label': 'Settings categories' }, [
    el('span', { class: 'settings-index-label' }, 'Jump to'),
    ...[
      ['settings-models', '01', 'Models'],
      ['settings-connections', '02', 'Connections'],
      ['settings-automation', '03', 'Automation'],
      ['settings-identity', '04', 'Identity'],
    ].map(([id, number, label]) => el('a', { href: `#${id}` }, [
      el('span', { 'aria-hidden': 'true' }, number),
      el('strong', {}, label),
    ])),
  ]);
}

function settingsGroup(id, title, description, children) {
  const headingId = `${id}-heading`;
  return el('section', { class: 'settings-group', id, 'aria-labelledby': headingId }, [
    el('div', { class: 'settings-group-head' }, [
      el('h2', { id: headingId }, title),
      el('p', { class: 'muted' }, description),
    ]),
    ...children,
  ]);
}

function configuredLocalModel(settings) {
  const provider = settings.localLlmProvider || 'ollama';
  if (provider === 'lmstudio') return Boolean(settings.lmstudioHost && settings.lmstudioModel);
  if (provider === 'omlx') return Boolean(settings.omlxHost && settings.omlxModel);
  return Boolean(settings.ollamaHost && settings.ollamaModel);
}

function settingsOverview({ settings, codex, claude }) {
  const localProvider = settings.localLlmProvider || 'ollama';
  const localParams = currentParameters(settings, localProvider);
  const hostedProvider = settings.llmProvider || 'claude';
  const hostedParams = currentParameters(settings, hostedProvider);
  const hostedReady = hostedProvider === 'codex' ? Boolean(codex && codex.connected) : Boolean(claude && claude.connected);
  const planningReady = Boolean(settings.planningConfigured || settings.hasKey);
  const repositoryReady = Boolean(settings.repositoryConfigured);
  const cards = [
    ['#settings-models', 'Local model', configuredLocalModel(settings), `${PROVIDER_LABELS[localProvider] || localProvider} · ${localParams.model || 'Choose model'}`],
    ['#settings-models', 'Hosted model', hostedReady, `${PROVIDER_LABELS[hostedProvider] || hostedProvider} · ${hostedParams.model || 'Choose model'}`],
    ['#settings-connections', 'Planning', planningReady, settings.planningProvider === 'jira' ? 'Jira' : settings.planningProvider === 'asana' ? 'Asana' : 'Linear'],
    ['#settings-connections', 'Repository', repositoryReady, settings.repositoryProvider === 'gitlab' ? 'GitLab' : 'GitHub'],
  ];
  return el('section', { class: 'settings-overview', 'aria-label': 'Configuration health' }, cards.map(([href, label, ready, value]) =>
    el('a', { class: `settings-health-card ${ready ? 'ok' : 'warn'}`, href }, [
      el('span', { class: 'settings-health-label' }, label),
      el('strong', { dataset: { i18nSkip: 'true' } }, value),
      el('small', {}, ready ? 'Configured' : 'Needs attention'),
    ])
  ));
}

/* ---------------------- Runtime & workflow pattern --------------------- */

function runtimeSection({ settings, codex, claude }) {
  const codexReady = codex.connected && settings.llmProvider === 'codex';
  const claudeReady = claude.connected && settings.llmProvider === 'claude';
  const runtimes = [
    ['deepagent', 'DeepAgent SDK'],
    ['codex-sdk', 'Codex SDK'],
    ['claude-agent-sdk', 'Claude Agent SDK'],
  ];
  const patterns = [
    ['sequential', 'Sequential'],
    ['parallel', 'Parallel / fan-out'],
    ['evaluator', 'Evaluator / retry'],
    ['supervisor', 'Supervisor / handoff'],
  ];
  const runtime = el('select', {}, runtimes.map(([value, label]) =>
    el('option', { value, ...(settings.agentRuntime === value ? { selected: 'selected' } : {}) }, label)
  ));
  const pattern = el('select', {}, patterns.map(([value, label]) =>
    el('option', { value, ...((settings.workflowPattern || 'sequential') === value ? { selected: 'selected' } : {}) }, label)
  ));
  const status = el('span', { class: 'muted', role: 'status', style: 'font-size:11px' });
  const save = el('button', { class: 'primary', type: 'button' }, 'Save runtime');
  const readiness = el('div', { class: 'runtime-readiness' }, [
    el('span', {}, [el('strong', {}, 'DeepAgent'), el('small', {}, 'Ready')]),
    el('span', {}, [el('strong', {}, 'Codex SDK'), el('small', {}, codexReady ? 'Ready' : codex.connected ? 'Select Codex hosted slot' : 'Sign-in needed')]),
    el('span', {}, [el('strong', {}, 'Claude SDK'), el('small', {}, claudeReady ? 'Ready' : claude.connected ? 'Select Claude hosted slot' : 'Sign-in needed')]),
  ]);

  const updateHint = () => {
    if (runtime.value === 'codex-sdk') {
      status.textContent = codexReady
        ? 'Uses the hosted Codex slot for compatible planning runs; brokered coding stays on DeepAgent.'
        : 'Choose Codex in the Hosted model slot and sign in; until then runs safely use DeepAgent.';
    } else if (runtime.value === 'claude-agent-sdk') {
      status.textContent = claudeReady
        ? 'Uses the hosted Claude slot for compatible planning runs; brokered coding stays on DeepAgent.'
        : 'Choose Claude in the Hosted model slot and sign in; until then runs safely use DeepAgent.';
    } else {
      status.textContent = 'Uses the existing skills-and-tools DeepAgent runtime.';
    }
  };
  runtime.addEventListener('change', updateHint);
  updateHint();

  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const next = await api.saveAgentRuntime({
        agentRuntime: runtime.value,
        workflowPattern: pattern.value,
      });
      status.textContent = `Saved ${next.agentRuntime} with the ${next.workflowPattern} pattern. New runs will use this setup.`;
      toast('Agent runtime saved.', 'ok');
    } catch (err) {
      status.textContent = err.message;
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
      save.textContent = 'Save runtime';
    }
  });

  const runtimeLabel = runtimes.find(([id]) => id === (settings.agentRuntime || 'deepagent'))?.[1] || 'DeepAgent SDK';
  const patternLabel = patterns.find(([id]) => id === (settings.workflowPattern || 'sequential'))?.[1] || 'Sequential';
  return section('Agent runtime & workflow', `${runtimeLabel} · ${patternLabel}`, true, [
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:0' }, 'Select the SDK for compatible planning work. Credential-brokered coding runs use DeepAgent. Every effective runtime creates a LangSmith root trace when tracing is enabled.'),
    readiness,
    field('Agent SDK', runtime),
    field('Workflow pattern', pattern, 'Patterns are bounded orchestration guidance: sequential, fan-out, evaluator/retry, or supervisor/handoff.'),
    el('div', { class: 'row' }, [save, status]),
    el('a', { class: 'detail-link', href: '#/workflows' }, 'Compare workflow patterns'),
  ]);
}

/* --------------------------- Collapsible box ---------------------------- */

function section(title, subtitle, open, children) {
  return el('details', { class: 'section', ...(open ? { open: 'open' } : {}) }, [
    el('summary', {}, [
      el('span', { class: 'section-title', role: 'heading', 'aria-level': '3' }, title),
      subtitle ? el('span', { class: 'section-sub' }, subtitle) : null,
    ]),
    el('div', { class: 'section-body' }, children),
  ]);
}

let fieldSequence = 0;
const field = (label, control, hint) => {
  const target = control.matches && control.matches('input, select, textarea')
    ? control
    : control.querySelector && control.querySelector('input, select, textarea');
  if (target && !target.id) target.id = `settings-field-${++fieldSequence}`;
  return el('div', { class: 'field' }, [
    el('label', target ? { for: target.id } : {}, label),
    control,
    hint ? el('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px' }, hint) : null,
  ]);
};

const pwd = (placeholder) => el('input', { type: 'password', autocomplete: 'off', placeholder });

/* ------------------------- Keys & connection ---------------------------- */

function keysSection(settings) {
  const status = el('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' });

  const linearInput = pwd(settings.hasKey ? `Saved: ${settings.maskedKey}` : 'lin_api_…');
  const langsmithInput = pwd(settings.hasLangsmithKey ? `Saved: ${settings.maskedLangsmithKey}` : 'lsv2_…');
  const hostInput = el('input', { value: settings.langsmithEndpoint || '', placeholder: 'https://api.smith.langchain.com' });
  const projectInput = el('input', { value: settings.langsmithProject || '', placeholder: 'linear-manager' });
  const tracingInput = el('input', { type: 'checkbox', style: 'width:auto', ...(settings.langsmithTracing ? { checked: 'checked' } : {}) });

  const saveBtn = el('button', { class: 'primary' }, 'Save keys');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (linearInput.value.trim()) {
        const r = await api.saveKey(linearInput.value.trim());
        linearInput.value = '';
        linearInput.placeholder = `Saved: ${r.maskedKey}`;
      }
      const lsPayload = {
        langsmithProject: projectInput.value.trim() || 'linear-manager',
        langsmithEndpoint: hostInput.value.trim() || 'https://api.smith.langchain.com',
        langsmithTracing: tracingInput.checked,
      };
      if (langsmithInput.value.trim()) lsPayload.langsmithApiKey = langsmithInput.value.trim();
      const lr = await api.saveLangsmith(lsPayload);
      langsmithInput.value = '';
      langsmithInput.placeholder = lr.hasLangsmithKey ? `Saved: ${lr.maskedLangsmithKey}` : 'lsv2_…';

      status.textContent = 'Keys saved.';
      status.style.color = 'var(--green)';
      toast('Keys saved.', 'ok');
      window.dispatchEvent(new Event('lm:connection-changed'));
    } catch (err) {
      status.textContent = err.message;
      status.style.color = 'var(--red)';
      toast(err.message, 'err');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save keys';
    }
  });

  const removeLinear = el('button', {
    class: 'danger',
    onclick: async () => {
      await api.clearKey();
      linearInput.placeholder = 'lin_api_…';
      status.textContent = 'Linear key removed.';
      status.style.color = 'var(--muted)';
      toast('Linear key removed.');
      window.dispatchEvent(new Event('lm:connection-changed'));
    },
  }, 'Remove Linear key');

  // Reflect current connection state.
  if (settings.hasKey) {
    api
      .validate()
      .then((r) => {
        const who = r.viewer ? r.viewer.name : 'your account';
        const org = r.organization ? ` @ ${r.organization.name}` : '';
        status.textContent = `Connected as ${who}${org}.`;
        status.style.color = 'var(--green)';
      })
      .catch((err) => {
        status.textContent = `Linear key not working: ${err.message}`;
        status.style.color = 'var(--red)';
      });
  } else {
    status.textContent = 'No Linear key configured yet.';
  }

  return section('API Keys & Connection', 'Linear · LangSmith', true, [
    el('div', { class: 'subhead' }, 'Linear'),
    field('Linear API Key', linearInput, [
      'Personal key from ',
      el('a', { href: 'https://linear.app/settings/api', target: '_blank', style: 'color:var(--accent-2)' }, 'linear.app/settings/api'),
      '.',
    ]),
    el('div', { class: 'subhead' }, 'LangSmith Tracing'),
    field('LangSmith API Key', langsmithInput),
    field('Host / Endpoint', hostInput),
    field('Project', projectInput),
    el('label', { class: 'row', style: 'gap:8px;cursor:pointer;margin-bottom:14px' }, [tracingInput, el('span', {}, 'Enable tracing')]),
    el('div', { class: 'row' }, [saveBtn, settings.hasKey ? removeLinear : null]),
    status,
    el('p', { class: 'muted', style: 'font-size:12px' }, 'All keys are stored server-side and never returned to the browser.'),
  ]);
}

/* ------------------------ Tool integrations ---------------------------- */

function integrationsSection(settings) {
  const planningProvider = el('select', {}, [
    el('option', { value: 'linear', selected: settings.planningProvider === 'linear' }, 'Linear'),
    el('option', { value: 'jira', selected: settings.planningProvider === 'jira' }, 'Jira'),
    el('option', { value: 'asana', selected: settings.planningProvider === 'asana' }, 'Asana'),
  ]);
  const repositoryProvider = el('select', {}, [
    el('option', { value: 'github', selected: settings.repositoryProvider !== 'gitlab' }, 'GitHub'),
    el('option', { value: 'gitlab', selected: settings.repositoryProvider === 'gitlab' }, 'GitLab'),
  ]);

  const repositoryUrl = el('input', {
    value: settings.repositoryUrl || '',
    placeholder: settings.repositoryProvider === 'gitlab' ? 'group/project' : 'owner/repository',
  });
  const githubToken = pwd(settings.hasGithubToken ? `Saved: ${settings.maskedGithubToken}` : 'github_pat_… / ghp_…');
  const gitlabToken = pwd(settings.hasGitlabToken ? `Saved: ${settings.maskedGitlabToken}` : 'glpat-…');
  const jiraBaseUrl = el('input', { value: settings.jiraBaseUrl || '', placeholder: 'https://company.atlassian.net' });
  const jiraEmail = el('input', { value: settings.jiraEmail || '', type: 'email', placeholder: 'you@company.com' });
  const jiraToken = pwd(settings.hasJiraToken ? `Saved: ${settings.maskedJiraToken}` : 'Jira API token');
  const asanaWorkspaceId = el('input', { value: settings.asanaWorkspaceId || '', placeholder: 'Workspace GID' });
  const asanaToken = pwd(settings.hasAsanaToken ? `Saved: ${settings.maskedAsanaToken}` : 'Asana personal access token');
  const status = el('div', { class: 'muted', style: 'font-size:12px;min-height:18px' });

  const removalControl = (saved, label, tokenInput) => {
    const checkbox = el('input', { type: 'checkbox', style: 'width:auto' });
    const row = el('label', { class: 'row connector-remove', style: 'gap:8px;cursor:pointer' }, [
      checkbox,
      el('span', {}, label),
    ]);
    row.hidden = !saved;
    checkbox.addEventListener('change', () => {
      tokenInput.disabled = checkbox.checked;
      if (checkbox.checked) tokenInput.value = '';
    });
    return { checkbox, row, tokenInput };
  };
  const clearGithub = removalControl(settings.hasGithubToken, 'Remove saved GitHub token', githubToken);
  const clearGitlab = removalControl(settings.hasGitlabToken, 'Remove saved GitLab token', gitlabToken);
  const clearJira = removalControl(settings.hasJiraToken, 'Remove saved Jira token', jiraToken);
  const clearAsana = removalControl(settings.hasAsanaToken, 'Remove saved Asana token', asanaToken);

  const linearFields = el('div', {}, [
    el('div', { class: 'connector-note' }, [
      el('strong', {}, settings.hasKey ? 'Linear is connected.' : 'Linear needs a key.'),
      el('span', {}, settings.hasKey
        ? ' Projects, planning, and agent updates use the Linear key saved above.'
        : ' Save a Linear key in API Keys & Connection to use project automation.'),
    ]),
  ]);
  const jiraFields = el('div', {}, [
    field('Jira site', jiraBaseUrl),
    field('Account email', jiraEmail),
    field('API token', jiraToken, 'Saved server-side. The token is never returned to this page.'),
    clearJira.row,
  ]);
  const asanaFields = el('div', {}, [
    field('Workspace ID', asanaWorkspaceId),
    field('Personal access token', asanaToken, 'Saved server-side. The token is never returned to this page.'),
    clearAsana.row,
  ]);
  const githubFields = el('div', {}, [
    field('GitHub token', githubToken, 'Fine-grained token with repository contents and pull-request access.'),
    clearGithub.row,
  ]);
  const gitlabFields = el('div', {}, [
    field('GitLab token', gitlabToken, 'Project token or personal token with repository write access.'),
    clearGitlab.row,
  ]);

  const syncVisibility = () => {
    linearFields.hidden = planningProvider.value !== 'linear';
    jiraFields.hidden = planningProvider.value !== 'jira';
    asanaFields.hidden = planningProvider.value !== 'asana';
    githubFields.hidden = repositoryProvider.value !== 'github';
    gitlabFields.hidden = repositoryProvider.value !== 'gitlab';
    repositoryUrl.placeholder = repositoryProvider.value === 'gitlab' ? 'group/project' : 'owner/repository';
  };
  planningProvider.addEventListener('change', syncVisibility);
  repositoryProvider.addEventListener('change', syncVisibility);
  syncVisibility();

  const save = el('button', { class: 'primary' }, 'Save integrations');
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    status.textContent = '';
    const payload = {
      planningProvider: planningProvider.value,
      repositoryProvider: repositoryProvider.value,
      repositoryUrl: repositoryUrl.value.trim(),
      jiraBaseUrl: jiraBaseUrl.value.trim(),
      jiraEmail: jiraEmail.value.trim(),
      asanaWorkspaceId: asanaWorkspaceId.value.trim(),
      clearGithubToken: clearGithub.checkbox.checked,
      clearGitlabToken: clearGitlab.checkbox.checked,
      clearJiraToken: clearJira.checkbox.checked,
      clearAsanaToken: clearAsana.checkbox.checked,
    };
    if (githubToken.value.trim()) payload.githubToken = githubToken.value.trim();
    if (gitlabToken.value.trim()) payload.gitlabToken = gitlabToken.value.trim();
    if (jiraToken.value.trim()) payload.jiraApiToken = jiraToken.value.trim();
    if (asanaToken.value.trim()) payload.asanaAccessToken = asanaToken.value.trim();
    try {
      const next = await api.saveIntegrations(payload);
      githubToken.value = '';
      gitlabToken.value = '';
      jiraToken.value = '';
      asanaToken.value = '';
      githubToken.placeholder = next.hasGithubToken ? `Saved: ${next.maskedGithubToken}` : 'github_pat_… / ghp_…';
      gitlabToken.placeholder = next.hasGitlabToken ? `Saved: ${next.maskedGitlabToken}` : 'glpat-…';
      jiraToken.placeholder = next.hasJiraToken ? `Saved: ${next.maskedJiraToken}` : 'Jira API token';
      asanaToken.placeholder = next.hasAsanaToken ? `Saved: ${next.maskedAsanaToken}` : 'Asana personal access token';
      for (const [control, saved] of [
        [clearGithub, next.hasGithubToken],
        [clearGitlab, next.hasGitlabToken],
        [clearJira, next.hasJiraToken],
        [clearAsana, next.hasAsanaToken],
      ]) {
        control.checkbox.checked = false;
        control.tokenInput.disabled = false;
        control.row.hidden = !saved;
      }
      status.textContent = 'Integration choices saved.';
      status.style.color = 'var(--green)';
      toast('Integrations saved.', 'ok');
      window.dispatchEvent(new Event('lm:connection-changed'));
    } catch (err) {
      status.textContent = err.message;
      status.style.color = 'var(--red)';
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
      save.textContent = 'Save integrations';
    }
  });

  const repoName = settings.repositoryProvider === 'gitlab' ? 'GitLab' : 'GitHub';
  const planName = ({ linear: 'Linear', jira: 'Jira', asana: 'Asana' })[settings.planningProvider] || 'Linear';
  return section('Tool integrations', `${planName} · ${repoName}`, true, [
    el('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, 'Save planning-connector and repository credentials on this server. Live project views and scheduled planning remain Linear-backed; Jira and Asana are ready as stored connector choices for routing extensions.'),
    el('div', { class: 'subhead' }, 'Project planning'),
    field('Planning tool', planningProvider),
    linearFields,
    jiraFields,
    asanaFields,
    el('div', { class: 'subhead' }, 'Code repository'),
    field('Repository host', repositoryProvider),
    field('Default repository', repositoryUrl, 'Use owner/name, group/project, or a GitHub/GitLab Git URL.'),
    githubFields,
    gitlabFields,
    el('div', { class: 'row' }, [save, status]),
  ]);
}

/* ------------------------------- Deep Agent LLM ------------------------- */

function llmSection(ctx) {
  const container = el('div', { class: 'llm-section' });
  const rebuild = () => {
    const previous = container.firstElementChild;
    const wasOpen = previous && previous.tagName === 'DETAILS' ? previous.open : null;
    const customOpen = new Set(
      [...container.querySelectorAll('.preset-card')]
        .filter((card) => card.querySelector('.preset-customize[open]'))
        .map((card) => card.dataset.role)
    );
    clear(container).append(buildLlmSection(ctx, rebuild));
    if (wasOpen === true && container.firstElementChild) container.firstElementChild.open = true;
    for (const role of customOpen) {
      const details = container.querySelector(`.preset-card[data-role="${role}"] .preset-customize`);
      if (details) details.open = true;
    }
  };

  rebuild();
  queueMicrotask(() => {
    void discoverProviderModels(ctx, 'local', roleProvider(ctx.settings, 'local'), false, rebuild);
    void discoverProviderModels(ctx, 'hosted', roleProvider(ctx.settings, 'hosted'), false, rebuild);
  });
  return container;
}

const PROVIDER_LABELS = Object.freeze({
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  omlx: 'oMLX',
  codex: 'OpenAI',
  claude: 'Anthropic',
});

const ROLE_PROVIDERS = Object.freeze({
  local: ['ollama', 'lmstudio', 'omlx'],
  hosted: ['codex', 'claude'],
});

const LOCAL_PROVIDERS = new Set(ROLE_PROVIDERS.local);

const REASONING_META = Object.freeze({
  none: { label: 'Off', description: 'Do not request additional reasoning from this model.' },
  low: { label: 'Low', description: 'Fast responses with lighter reasoning.' },
  medium: { label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks.' },
  high: { label: 'High', description: 'Greater reasoning depth for complex problems.' },
  xhigh: { label: 'Extra high', description: 'Extra high reasoning depth for complex problems.' },
  max: { label: 'Max', description: 'Maximum reasoning depth for the hardest problems.' },
  ultra: { label: 'Ultra', description: 'Maximum reasoning with automatic task delegation.' },
});

function buildLlmSection(ctx, rebuild) {
  const localPreset = findPreset(ctx, ctx.settings.localLlmPresetId, 'local');
  const hostedPreset = findPreset(ctx, ctx.settings.hostedLlmPresetId, 'hosted');
  const localProvider = localPreset ? localPreset.provider : ctx.settings.localLlmProvider;
  const hostedProvider = hostedPreset ? hostedPreset.provider : ctx.settings.llmProvider;
  const localName = `${PROVIDER_LABELS[localProvider] || localProvider} · ${currentParameters(ctx.settings, localProvider).model || 'Choose model'}`;
  const hostedName = `${PROVIDER_LABELS[hostedProvider] || hostedProvider} · ${currentParameters(ctx.settings, hostedProvider).model || 'Choose model'}`;

  return section('Model routes', `Local: ${localName} · Hosted: ${hostedName}`, true, [
    el('p', { class: 'muted settings-section-intro' }, 'Small jobs stay private on your local server. Planning and larger work use the hosted route. Model changes save immediately; connection and advanced values use an explicit save.'),
    el('div', { class: 'preset-stack' }, [
      presetSlot(ctx, 'local', rebuild),
      presetSlot(ctx, 'hosted', rebuild),
    ]),
  ]);
}

function findPreset(ctx, id, deployment) {
  return (ctx.presets.presets || []).find((preset) => preset.id === id && preset.deployment === deployment) || null;
}

function roleProvider(settings, role) {
  return role === 'local' ? settings.localLlmProvider : settings.llmProvider;
}

function selectedPresetId(settings, role) {
  return role === 'local' ? settings.localLlmPresetId : settings.hostedLlmPresetId;
}

function presetSlot(ctx, role, rebuild) {
  const deployment = role === 'local' ? 'local' : 'hosted';
  const preset = findPreset(ctx, selectedPresetId(ctx.settings, role), deployment);
  const provider = preset ? preset.provider : roleProvider(ctx.settings, role);
  const params = currentParameters(ctx.settings, provider);
  const customized = Boolean(preset && presetCustomized(preset, params));
  const pending = Boolean(ctx.selectionPending[role]);
  const modelEntries = modelsForProvider(ctx, provider);
  const selectedModel = modelEntries.find((entry) => entry.id === params.model) || null;
  const profilePreset = preset || findPresetForModel(ctx, provider, params.model);
  const reasoningOptions = reasoningOptionsFor(selectedModel, profilePreset);
  const modelDefaultReasoning = defaultReasoningFor(selectedModel, profilePreset);
  const profileAdapter = selectedModel && selectedModel.reasoningAdapter ||
    profilePreset && profilePreset.capabilities && profilePreset.capabilities.reasoningAdapter || 'none';
  const currentAdapter = configuredReasoningAdapter(ctx.settings, provider);
  const adapterActive = currentAdapter === profileAdapter;
  const currentReasoning = adapterActive && reasoningOptions.some((option) => option.value === params.reasoningEffort)
    ? params.reasoningEffort
    : '';
  const editorPreset = preset || customEditorPreset(provider, params, ctx.settings, deployment);

  const applySelection = async ({ nextProvider, model, reasoningEffort, mode }) => {
    ctx.selectionPending[role] = true;
    rebuild();
    try {
      const response = await api.applyLlmSelection({
        role,
        provider: nextProvider,
        model,
        reasoningEffort,
        mode,
      });
      Object.assign(ctx.settings, response && response.settings ? response.settings : response);
      toast(
        mode === 'reasoning'
          ? `Reasoning set to ${reasoningLabel(reasoningEffort)}.`
          : `${PROVIDER_LABELS[nextProvider] || nextProvider} model set to ${model}.`,
        'ok'
      );
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      ctx.selectionPending[role] = false;
      rebuild();
    }
  };

  const providerSelect = optionSelect(
    ROLE_PROVIDERS[role].map((value) => [value, PROVIDER_LABELS[value] || value]),
    provider
  );
  providerSelect.className = 'llm-provider-select';
  providerSelect.disabled = pending;
  providerSelect.addEventListener('change', () => {
    const nextProvider = providerSelect.value;
    void (async () => {
      ctx.selectionPending[role] = true;
      rebuild();
      try {
        await discoverProviderModels(ctx, role, nextProvider, false, rebuild);
        const recommended = recommendedModelEntry(ctx, nextProvider);
        if (!recommended) {
          ctx.selectionPending[role] = false;
          rebuild();
          return toast(`No models are configured for ${PROVIDER_LABELS[nextProvider] || nextProvider}.`, 'err');
        }
        await applySelection({
          nextProvider,
          model: recommended.id,
          reasoningEffort: defaultReasoningFor(recommended, recommended.preset),
          mode: 'model',
        });
      } catch (err) {
        ctx.selectionPending[role] = false;
        rebuild();
        toast(err.message, 'err');
      }
    })();
  });

  const modelSelect = modelSelectControl(modelEntries, params.model);
  modelSelect.disabled = pending || !modelEntries.length;
  modelSelect.addEventListener('change', () => {
    const selected = modelEntries.find((entry) => entry.id === modelSelect.value);
    if (!selected) return;
    void applySelection({
      nextProvider: provider,
      model: selected.id,
      reasoningEffort: defaultReasoningFor(selected, selected.preset),
      mode: 'model',
    });
  });

  const reasoningSelect = optionSelect(
    [
      ...(!currentReasoning && reasoningOptions.length
        ? [['', `Apply ${reasoningLabel(modelDefaultReasoning)} default…`]]
        : []),
      ...reasoningOptions.map((option) => [
        option.value,
        `${option.label}${option.value === modelDefaultReasoning ? ' (default)' : ''}`,
      ]),
    ],
    currentReasoning
  );
  reasoningSelect.className = 'llm-reasoning-select';
  reasoningSelect.disabled = pending || !reasoningOptions.length;
  const reasoningHint = el('span', {}, reasoningDescription(reasoningOptions, currentReasoning));
  reasoningSelect.addEventListener('change', () => {
    const chosen = reasoningOptions.find((option) => option.value === reasoningSelect.value);
    reasoningHint.textContent = chosen ? chosen.description : '';
    if (!chosen) return;
    void applySelection({
      nextProvider: provider,
      model: params.model,
      reasoningEffort: chosen.value,
      mode: 'reasoning',
    });
  });

  const heading = role === 'local' ? 'Local / XS tasks' : 'Hosted / planner + larger tasks';
  const description = role === 'local'
    ? LOCAL_PROVIDERS.has(provider)
      ? `Runs privately through ${PROVIDER_LABELS[provider] || provider}.`
      : 'Legacy custom route for XS tasks using a hosted OAuth provider.'
    : provider === 'codex' || provider === 'claude'
      ? 'Used by planning and every hosted or unlabeled coding task.'
      : 'Legacy custom planner route using a local inference server.';
  const status = modelDiscoveryStatus(ctx, role, provider, params.model, rebuild);
  const children = [
    el('div', { class: 'preset-card-head' }, [
      el('div', {}, [el('div', { class: 'preset-title' }, heading), el('div', { class: 'muted preset-route' }, description)]),
      customized || !preset ? el('span', { class: 'badge preset-custom-badge' }, 'Customized') : null,
    ]),
    el('div', { class: 'llm-primary-grid' }, [
      field('Provider', providerSelect),
      field('Model', modelSelect, modelEntries.length ? `${modelEntries.length} model${modelEntries.length === 1 ? '' : 's'} available in this list.` : 'No models found yet.'),
      field('Reasoning', reasoningSelect, reasoningHint),
    ]),
  ];

  if (preset || selectedModel) {
    const descriptionText = (selectedModel && selectedModel.description) || (preset && preset.description);
    children.push(
      descriptionText ? el('p', { class: 'preset-description' }, descriptionText) : null,
      parameterSummary(params, reasoningOptions, currentReasoning),
      profilePreset && profilePreset.requirements ? el('p', { class: 'muted preset-requirement' }, [
        profilePreset.requirements,
        profilePreset.sourceUrl ? ' ' : null,
        profilePreset.sourceUrl ? el('a', { href: profilePreset.sourceUrl, target: '_blank', rel: 'noopener', class: 'preset-doc-link' }, 'Model docs ↗') : null,
      ]) : null
    );
  } else {
    children.push(
      el('div', { class: 'preset-legacy-note' }, [
        el('strong', {}, `Custom ${PROVIDER_LABELS[provider] || provider} configuration`),
        el('span', {}, ' This discovered model has no catalog profile, so provider-specific reasoning overrides remain disabled.'),
      ])
    );
  }

  if (deployment === 'local' && editorPreset) {
    children.push(localConnectionEditor(ctx, role, editorPreset, params, rebuild));
  }
  children.push(status);
  if (provider === 'codex' || provider === 'claude') {
    children.push(hostedConnection(ctx, provider));
  }
  if (editorPreset) children.push(parameterEditor(ctx, role, editorPreset, params, rebuild));

  return el('div', { class: `preset-card preset-card-${deployment}`, dataset: { role } }, children);
}

function customEditorPreset(provider, params, settings, deployment) {
  const isOllama = provider === 'ollama';
  const isLmstudio = provider === 'lmstudio';
  const isOmlx = provider === 'omlx';
  const isOpenAiLocal = isLmstudio || isOmlx;
  const isCodex = provider === 'codex';
  let adapter = 'none';
  if (isOllama && ['ollama-think-effort', 'ollama-think-toggle'].includes(settings.ollamaReasoningAdapter)) {
    adapter = settings.ollamaReasoningAdapter;
  } else if (isLmstudio && settings.lmstudioReasoningAdapter === 'openai-compatible') {
    adapter = 'openai-compatible';
  } else if (isOmlx && settings.omlxReasoningAdapter === 'omlx-template-effort') {
    adapter = 'omlx-template-effort';
  } else if (isCodex && settings.codexReasoningAdapter === 'openai') {
    adapter = 'openai';
  } else if (!isOpenAiLocal && !isOllama && !isCodex &&
    ['anthropic-adaptive', 'anthropic-effort'].includes(settings.claudeReasoningAdapter)) {
    adapter = settings.claudeReasoningAdapter;
  }

  let efforts = ['none'];
  if (adapter === 'ollama-think-effort' || adapter === 'omlx-template-effort') efforts = ['low', 'medium', 'high'];
  else if (adapter === 'ollama-think-toggle') efforts = ['none', 'medium'];
  else if (adapter === 'openai-compatible') efforts = ['none', 'low', 'medium', 'high'];
  else if (adapter === 'openai') efforts = ['none', 'low', 'medium', 'high', 'xhigh'];
  else if (adapter === 'anthropic-adaptive' || adapter === 'anthropic-effort') {
    efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  }

  const parameter = {
    'ollama-think-effort': 'think',
    'ollama-think-toggle': 'think',
    'openai-compatible': 'reasoning_effort',
    'omlx-template-effort': 'chat_template_kwargs.reasoning_effort',
    openai: 'reasoning.effort',
    'anthropic-adaptive': 'thinking.type=adaptive + output_config.effort',
    'anthropic-effort': 'output_config.effort',
  }[adapter] || null;
  return {
    id: 'custom',
    provider,
    deployment,
    model: params.model,
    limits: {
      contextWindow: isOllama || isOpenAiLocal ? 262144 : isCodex ? 1050000 : 1000000,
      maxOutputTokens: 128000,
    },
    requestLimits: {
      maxOutputContextFraction: isOpenAiLocal ? 0.5 : isOllama ? 1 : null,
    },
    capabilities: {
      temperature: isOllama || isOpenAiLocal || (isCodex && adapter === 'none'),
      contextWindowConfigurable: isOllama || isOpenAiLocal,
      reasoningAdapter: adapter,
      reasoningEfforts: efforts,
    },
    parameters: {
      contextWindow: params.contextWindow,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      repeatPenalty: params.repeatPenalty,
      reasoning: { effort: params.reasoningEffort, parameter },
      jsonMode: params.jsonMode,
      contextMode: params.contextMode,
    },
  };
}

function normalizedModel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function modelMatchesPreset(preset, model) {
  const actual = normalizedModel(model);
  const patterns = [preset.model, ...(preset.modelPatterns || [])].map(normalizedModel).filter(Boolean);
  return preset.deployment === 'hosted'
    ? patterns.includes(actual)
    : patterns.some((pattern) => actual.includes(pattern));
}

function findPresetForModel(ctx, provider, model) {
  return (ctx.presets.presets || []).find((preset) => preset.provider === provider && modelMatchesPreset(preset, model)) || null;
}

function discoveryState(ctx, provider) {
  if (!ctx.discovery[provider]) {
    ctx.discovery[provider] = {
      models: [], loading: false, loaded: false, reachable: null,
      source: 'catalog', error: '', requestId: 0,
    };
  }
  return ctx.discovery[provider];
}

function modelEntryFromPreset(preset) {
  return {
    id: preset.model,
    label: preset.label || preset.model,
    description: preset.description || '',
    contextWindow: preset.limits && preset.limits.contextWindow,
    maxOutputTokens: preset.limits && preset.limits.maxOutputTokens,
    reasoningAdapter: preset.capabilities && preset.capabilities.reasoningAdapter,
    reasoningEfforts: preset.capabilities && preset.capabilities.reasoningEfforts,
    defaultReasoningEffort: preset.parameters && preset.parameters.reasoning && preset.parameters.reasoning.effort,
    source: 'catalog',
    recommended: Boolean(preset.recommended),
    preset,
  };
}

function discoveredModelEntry(ctx, provider, raw, source) {
  const value = typeof raw === 'string' ? { id: raw } : raw || {};
  const id = String(value.id || value.model || '').trim();
  if (!id) return null;
  const preset = findPresetForModel(ctx, provider, id);
  const catalog = preset ? modelEntryFromPreset(preset) : {};
  const modelSource = value.source || source || 'provider';
  return {
    ...catalog,
    ...value,
    id,
    label: value.label || catalog.label || id,
    description: value.description || catalog.description || '',
    reasoningAdapter: value.reasoningAdapter || catalog.reasoningAdapter || 'none',
    reasoningEfforts: Array.isArray(value.reasoningEfforts) ? value.reasoningEfforts : catalog.reasoningEfforts || [],
    defaultReasoningEffort: value.defaultReasoningEffort || catalog.defaultReasoningEffort || 'none',
    source: modelSource,
    available: ['live', 'local', 'provider'].includes(modelSource),
    recommended: value.recommended === undefined ? Boolean(catalog.recommended) : Boolean(value.recommended),
    preset: preset || null,
  };
}

function modelsForProvider(ctx, provider) {
  const entries = new Map();
  for (const preset of (ctx.presets.presets || []).filter((item) => item.provider === provider)) {
    const entry = modelEntryFromPreset(preset);
    entries.set(entry.id, entry);
  }
  const state = discoveryState(ctx, provider);
  for (const entry of state.models) {
    const current = entries.get(entry.id);
    entries.set(entry.id, current ? { ...current, ...entry, preset: entry.preset || current.preset } : entry);
  }
  const configured = currentParameters(ctx.settings, provider).model;
  if (configured && !entries.has(configured)) {
    const preset = findPresetForModel(ctx, provider, configured);
    entries.set(configured, {
      ...(preset ? modelEntryFromPreset(preset) : {}),
      id: configured,
      label: configured,
      source: 'current',
      available: state.models.some((entry) => entry.id === configured),
      preset,
    });
  }
  const values = [...entries.values()].map((entry) => {
    if (provider !== 'codex' || !ctx.codex || ctx.codex.backend !== 'api') return entry;
    const efforts = normalizeReasoningOptions(entry.reasoningEfforts)
      .filter((effort) => effort.value !== 'ultra');
    return {
      ...entry,
      reasoningEfforts: efforts,
      defaultReasoningEffort: efforts.some((effort) => effort.value === entry.defaultReasoningEffort)
        ? entry.defaultReasoningEffort
        : efforts.some((effort) => effort.value === 'medium') ? 'medium' : efforts[0] && efforts[0].value,
    };
  });
  return values.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (Boolean(a.available) !== Boolean(b.available)) return a.available ? -1 : 1;
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
  });
}

function recommendedModelEntry(ctx, provider) {
  const entries = modelsForProvider(ctx, provider);
  const recommendedPreset = (ctx.presets.presets || []).find((preset) => preset.provider === provider && preset.recommended);
  const availableAlias = recommendedPreset && entries.find((entry) => entry.available && modelMatchesPreset(recommendedPreset, entry.id));
  return availableAlias || entries.find((entry) => entry.available) ||
    entries.find((entry) => entry.recommended) || entries[0] || null;
}

function modelSelectControl(entries, current) {
  const option = (entry) => el('option', { value: entry.id, selected: entry.id === current, dataset: { i18nSkip: 'true' } },
    `${entry.recommended ? '★ ' : ''}${entry.label}${entry.label !== entry.id ? ` — ${entry.id}` : ''}`);
  const recommended = entries.filter((entry) => entry.recommended);
  const available = entries.filter((entry) => !entry.recommended && entry.available);
  const other = entries.filter((entry) => !entry.recommended && !entry.available);
  const groups = [];
  if (recommended.length) groups.push(el('optgroup', { label: 'Recommended' }, recommended.map(option)));
  if (available.length) groups.push(el('optgroup', { label: 'Available' }, available.map(option)));
  if (other.length) groups.push(el('optgroup', { label: 'Catalog / current' }, other.map(option)));
  return el('select', { class: 'llm-model-select' }, groups);
}

function normalizeReasoningOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.map((item) => {
    const value = typeof item === 'string' ? item : item && item.value;
    if (!value || seen.has(value)) return null;
    seen.add(value);
    const fallback = REASONING_META[value] || {
      label: value[0].toUpperCase() + value.slice(1),
      description: '',
    };
    return {
      value,
      label: typeof item === 'object' && item.label ? item.label : fallback.label,
      description: value === 'ultra'
        ? REASONING_META.ultra.description
        : typeof item === 'object' && item.description ? item.description : fallback.description,
    };
  }).filter(Boolean);
}

function reasoningOptionsFor(entry, preset) {
  if (entry && Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length) {
    return normalizeReasoningOptions(entry.reasoningEfforts);
  }
  return normalizeReasoningOptions(preset && preset.capabilities && preset.capabilities.reasoningEfforts);
}

function defaultReasoningFor(entry, preset) {
  const options = reasoningOptionsFor(entry, preset);
  const preferred = entry && entry.defaultReasoningEffort ||
    preset && preset.parameters && preset.parameters.reasoning && preset.parameters.reasoning.effort;
  return options.some((option) => option.value === preferred)
    ? preferred
    : options[0] ? options[0].value : 'none';
}

function reasoningLabel(value) {
  return (REASONING_META[value] && REASONING_META[value].label) || value || 'Provider default';
}

function reasoningDescription(options, current) {
  const selected = options.find((option) => option.value === current);
  if (selected) return selected.description;
  return options.length
    ? 'Reasoning is not active for the saved configuration; choose a supported level to apply it.'
    : 'This model has no configurable reasoning profile.';
}

async function discoverProviderModels(ctx, role, provider, refresh, rebuild) {
  if (!provider || !ROLE_PROVIDERS[role].includes(provider)) return;
  const state = discoveryState(ctx, provider);
  const requestId = ++state.requestId;
  state.loading = true;
  state.error = '';
  rebuild();
  try {
    const response = await api.getProviderModels(provider, refresh);
    if (requestId !== state.requestId) return;
    const source = response.source || (LOCAL_PROVIDERS.has(provider) ? 'local' : 'provider');
    state.models = (response.models || [])
      .map((model) => discoveredModelEntry(ctx, provider, model, source))
      .filter(Boolean);
    state.reachable = response.reachable !== false;
    state.source = source;
    state.loaded = true;
  } catch (err) {
    if (requestId !== state.requestId) return;
    state.models = [];
    state.reachable = false;
    state.loaded = true;
    state.error = err.message || 'Model discovery failed.';
  } finally {
    if (requestId !== state.requestId) return;
    state.loading = false;
    if (roleProvider(ctx.settings, role) === provider) rebuild();
  }
}

function modelDiscoveryStatus(ctx, role, provider, model, rebuild) {
  const state = discoveryState(ctx, provider);
  const refresh = el('button', {
    class: 'preset-inline-action llm-refresh-models',
    disabled: state.loading ? 'disabled' : null,
    onclick: () => void discoverProviderModels(ctx, role, provider, true, rebuild),
  }, state.loading ? 'Refreshing…' : 'Refresh models');
  if (state.loading && !state.loaded) {
    return el('div', { class: 'preset-status busy', role: 'status', 'aria-live': 'polite' }, [
      el('span', {}, `Discovering ${PROVIDER_LABELS[provider] || provider} models…`), refresh,
    ]);
  }
  if (!state.loaded) {
    return el('div', { class: 'preset-status busy', role: 'status', 'aria-live': 'polite' }, [
      el('span', {}, 'Model catalog is ready; checking live availability…'), refresh,
    ]);
  }
  if (state.reachable === false) {
    return el('div', { class: 'preset-status warn', role: 'status', 'aria-live': 'polite' }, [
      el('span', {}, `${state.error || `${PROVIDER_LABELS[provider] || provider} is not reachable.`} Showing catalog and current models.`),
      refresh,
    ]);
  }
  const exact = state.models.some((entry) => entry.id === model);
  const count = state.models.length;
  const sourceLabel = state.source === 'fallback' || state.source === 'catalog' ? 'the catalog' : state.source || 'the provider';
  const message = LOCAL_PROVIDERS.has(provider)
    ? exact
      ? provider === 'omlx' ? `Ready · ${model} available` : `Ready · ${model} detected`
      : `${count} local model${count === 1 ? '' : 's'} available; ${model || 'the selected model'} was not found.`
    : `${count} ${PROVIDER_LABELS[provider] || provider} model${count === 1 ? '' : 's'} loaded from ${sourceLabel}.`;
  const healthy = LOCAL_PROVIDERS.has(provider)
    ? exact
    : state.source === 'live';
  return el('div', { class: `preset-status ${healthy ? 'ok' : 'warn'}`, role: 'status', 'aria-live': 'polite' }, [
    el('span', {}, message), refresh,
  ]);
}

function currentParameters(settings, provider) {
  if (provider === 'ollama') return {
    host: settings.ollamaHost,
    model: settings.ollamaModel,
    contextWindow: settings.ollamaContextWindow,
    maxOutputTokens: settings.ollamaNumTokens,
    temperature: settings.ollamaTemperature,
    topP: settings.ollamaTopP,
    topK: settings.ollamaTopK,
    repeatPenalty: settings.ollamaRepeatPenalty,
    reasoningEffort: settings.ollamaReasoningEffort || 'none',
    jsonMode: settings.ollamaJsonMode || 'json',
    contextMode: null,
  };
  if (provider === 'lmstudio') return {
    host: settings.lmstudioHost,
    model: settings.lmstudioModel,
    contextWindow: settings.lmstudioContextWindow,
    maxOutputTokens: settings.lmstudioNumTokens,
    temperature: settings.lmstudioTemperature,
    topP: settings.lmstudioTopP,
    topK: settings.lmstudioTopK,
    repeatPenalty: settings.lmstudioRepeatPenalty,
    reasoningEffort: settings.lmstudioReasoningEffort || 'none',
    jsonMode: settings.lmstudioJsonMode || 'text',
    contextMode: settings.lmstudioContextMode || 'summarize',
  };
  if (provider === 'omlx') return {
    host: settings.omlxHost,
    model: settings.omlxModel,
    contextWindow: settings.omlxContextWindow,
    maxOutputTokens: settings.omlxNumTokens,
    temperature: settings.omlxTemperature,
    topP: settings.omlxTopP,
    topK: settings.omlxTopK,
    repeatPenalty: settings.omlxRepeatPenalty,
    reasoningEffort: settings.omlxReasoningEffort || 'none',
    jsonMode: settings.omlxJsonMode || 'json_schema',
    contextMode: settings.omlxContextMode || 'summarize',
  };
  if (provider === 'codex') return {
    model: settings.codexModel || 'gpt-5.5',
    contextWindow: settings.codexContextWindow || 1050000,
    maxOutputTokens: settings.codexMaxTokens || 65536,
    temperature: settings.codexTemperature,
    topP: null, topK: null, repeatPenalty: null,
    reasoningEffort: settings.codexReasoningEffort || 'high',
    jsonMode: null,
    contextMode: null,
  };
  return {
    model: settings.claudeModel || 'claude-opus-4-8',
    contextWindow: settings.claudeContextWindow || 1000000,
    maxOutputTokens: settings.claudeMaxTokens || 65536,
    temperature: settings.claudeTemperature,
    topP: null, topK: null, repeatPenalty: null,
    reasoningEffort: settings.claudeReasoningEffort || 'xhigh',
    jsonMode: null,
    contextMode: null,
  };
}

function configuredReasoningAdapter(settings, provider) {
  if (provider === 'ollama') return settings.ollamaReasoningAdapter || 'none';
  if (provider === 'lmstudio') return settings.lmstudioReasoningAdapter || 'none';
  if (provider === 'omlx') return settings.omlxReasoningAdapter || 'none';
  if (provider === 'codex') return settings.codexReasoningAdapter || 'none';
  return settings.claudeReasoningAdapter || 'none';
}

function presetCustomized(preset, params) {
  const defaults = preset.parameters;
  return !modelMatchesPreset(preset, params.model) ||
    Number(params.contextWindow) !== Number(defaults.contextWindow) ||
    Number(params.maxOutputTokens) !== Number(defaults.maxOutputTokens) ||
    (params.temperature ?? null) !== (defaults.temperature ?? null) ||
    (params.topP ?? null) !== (defaults.topP ?? null) ||
    (params.topK ?? null) !== (defaults.topK ?? null) ||
    (params.repeatPenalty ?? null) !== (defaults.repeatPenalty ?? null) ||
    params.reasoningEffort !== defaults.reasoning.effort ||
    params.jsonMode !== defaults.jsonMode ||
    params.contextMode !== defaults.contextMode;
}

function compactTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000000) return `${Number((n / 1000000).toFixed(2))}M`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`;
  return String(n);
}

function parameterSummary(params, reasoningOptions = [], effectiveReasoning = params.reasoningEffort) {
  const temperature = typeof params.temperature === 'number' ? params.temperature : 'managed';
  const reasoning = reasoningOptions.some((option) => option.value === effectiveReasoning)
    ? reasoningLabel(effectiveReasoning)
    : 'Not selected';
  return el('div', { class: 'preset-params' }, [
    el('span', { class: 'param-chip' }, `Context ${compactTokens(params.contextWindow)}`),
    el('span', { class: 'param-chip' }, `Output ${compactTokens(params.maxOutputTokens)}`),
    el('span', { class: 'param-chip' }, `Reasoning ${reasoning}`),
    el('span', { class: 'param-chip' }, `Temperature ${temperature}`),
  ]);
}

function optionSelect(options, current) {
  return el('select', {}, options.map(([value, label]) => el('option', { value, selected: value === current }, label)));
}

function localConnectionEditor(ctx, role, preset, params, rebuild) {
  const provider = preset.provider;
  const isOmlx = provider === 'omlx';
  const meta = {
    ollama: {
      placeholder: 'http://127.0.0.1:11434',
      apiPath: '/api/tags',
      hint: 'Address of the Ollama server that exposes your installed models.',
    },
    lmstudio: {
      placeholder: 'http://127.0.0.1:1234',
      apiPath: '/v1/models',
      hint: 'Address of the LM Studio local server. Start the server before testing.',
    },
    omlx: {
      placeholder: 'http://127.0.0.1:8000',
      apiPath: '/v1/models',
      hint: 'Use the oMLX server origin or its /v1 API URL. The saved address is normalized automatically.',
    },
  }[provider];
  if (!meta) return null;

  const hostInput = el('input', {
    type: 'url',
    value: params.host || '',
    placeholder: meta.placeholder,
    autocomplete: 'url',
    spellcheck: 'false',
  });
  const endpoint = el('code', { class: 'local-endpoint-value', dataset: { i18nSkip: 'true' } });
  const refreshEndpoint = () => {
    let base = hostInput.value.trim().replace(/\/$/, '');
    if (isOmlx) base = base.replace(/\/v1$/i, '');
    endpoint.textContent = `${base || meta.placeholder}${meta.apiPath}`;
  };
  hostInput.addEventListener('input', refreshEndpoint);
  refreshEndpoint();

  const keyInput = isOmlx
    ? pwd(ctx.settings.hasOmlxApiKey ? `Saved: ${ctx.settings.maskedOmlxApiKey}` : 'Optional API key')
    : null;
  const clearKey = isOmlx && ctx.settings.hasOmlxApiKey
    ? el('input', { type: 'checkbox', style: 'width:auto' })
    : null;
  if (clearKey) {
    clearKey.addEventListener('change', () => {
      keyInput.disabled = clearKey.checked;
      if (clearKey.checked) keyInput.value = '';
    });
  }

  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });
  const save = el('button', { class: 'primary', type: 'button' }, 'Save & test');
  save.addEventListener('click', async () => {
    if (!hostInput.value.trim() || !hostInput.checkValidity()) {
      hostInput.reportValidity();
      return;
    }
    save.disabled = true;
    save.textContent = 'Testing…';
    info.textContent = 'Saving connection and refreshing models…';
    const overrides = {
      model: params.model,
      contextWindow: params.contextWindow,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      repeatPenalty: params.repeatPenalty,
      reasoningEffort: params.reasoningEffort,
      jsonMode: params.jsonMode,
      contextMode: params.contextMode,
      host: hostInput.value.trim(),
      ...(isOmlx && keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
      ...(isOmlx && clearKey && clearKey.checked ? { clearApiKey: true } : {}),
    };
    try {
      const next = await api.applyLlmPreset({
        role: role === 'local' ? 'local' : 'global',
        presetId: preset.id,
        provider,
        overrides,
      });
      Object.assign(ctx.settings, next);
      await discoverProviderModels(ctx, role, provider, true, rebuild);
      const live = discoveryState(ctx, provider);
      toast(
        live.reachable === false
          ? 'Connection saved, but the model server is not reachable.'
          : 'Connection saved and models refreshed.',
        live.reachable === false ? 'err' : 'ok'
      );
    } catch (err) {
      info.textContent = err.message;
      info.style.color = 'var(--red)';
      toast(err.message, 'err');
      save.disabled = false;
      save.textContent = 'Save & test';
    }
  });

  const fields = [
    field('Server address', hostInput, meta.hint),
    isOmlx ? field('API key', keyInput, 'Optional. It is stored server-side and is never returned to this page.') : null,
  ];
  return el('div', { class: 'local-connection' }, [
    el('div', { class: 'local-connection-head' }, [
      el('div', {}, [
        el('strong', {}, `${PROVIDER_LABELS[provider]} connection`),
        el('span', { class: 'muted' }, ' Configure the server before tuning model parameters.'),
      ]),
      isOmlx ? el('a', {
        class: 'detail-link', href: 'https://github.com/jundot/omlx', target: '_blank', rel: 'noopener',
      }, 'oMLX setup ↗') : null,
    ]),
    el('div', { class: 'local-connection-grid' }, fields),
    clearKey ? el('label', { class: 'row local-key-clear' }, [clearKey, el('span', {}, 'Remove saved API key')]) : null,
    el('div', { class: 'local-endpoint' }, [
      el('span', {}, 'Model discovery'), endpoint,
    ]),
    el('div', { class: 'row local-connection-actions' }, [save, info]),
  ]);
}

function parameterEditor(ctx, role, preset, params, rebuild) {
  const contextInput = el('input', {
    type: 'number', min: '512', max: String(preset.limits.contextWindow), value: String(params.contextWindow),
    ...(preset.capabilities.contextWindowConfigurable ? {} : { disabled: 'disabled' }),
  });
  const outputInput = el('input', {
    type: 'number', min: preset.provider === 'lmstudio' || preset.provider === 'omlx' ? '256' : '128',
    max: String(preset.limits.maxOutputTokens), value: String(params.maxOutputTokens),
  });
  const temperatureInput = preset.capabilities.temperature
    ? el('input', { type: 'number', min: '0', max: '2', step: '0.1', value: String(params.temperature ?? 0) })
    : el('input', { value: 'Provider managed', disabled: 'disabled' });
  const topPInput = preset.parameters.topP !== null
    ? el('input', { type: 'number', min: '0', max: '1', step: '0.05', value: String(params.topP ?? preset.parameters.topP) })
    : null;
  const topKInput = preset.parameters.topK !== null
    ? el('input', { type: 'number', min: '1', max: '1000', step: '1', value: String(params.topK ?? preset.parameters.topK) })
    : null;
  const repeatPenaltyInput = preset.parameters.repeatPenalty !== null
    ? el('input', { type: 'number', min: '0', max: '2', step: '0.01', value: String(params.repeatPenalty ?? preset.parameters.repeatPenalty) })
    : null;
  const jsonInput = preset.provider === 'ollama'
    ? optionSelect([['json', 'Constrained JSON'], ['text', 'Prompt-only text']], params.jsonMode)
    : preset.provider === 'lmstudio' || preset.provider === 'omlx'
      ? optionSelect([['text', 'Prompt-only text'], ['json_object', 'OpenAI json_object'], ['json_schema', 'Structured json_schema']], params.jsonMode)
      : null;
  const contextModeInput = preset.provider === 'lmstudio' || preset.provider === 'omlx'
    ? optionSelect([['summarize', 'Summarize old turns'], ['trim', 'Trim old turns'], ['none', 'None']], params.contextMode)
    : null;
  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });

  const syncLocalOutputLimit = () => {
    const fraction = preset.requestLimits && preset.requestLimits.maxOutputContextFraction;
    if (!Number.isFinite(fraction)) return;
    const minimum = preset.provider === 'lmstudio' || preset.provider === 'omlx' ? 256 : 128;
    const contextCap = Math.max(minimum, Math.floor(Number(contextInput.value) * fraction));
    const cap = Math.min(preset.limits.maxOutputTokens, contextCap);
    outputInput.max = String(cap);
    if (Number(outputInput.value) > cap) outputInput.value = String(cap);
  };
  contextInput.addEventListener('input', syncLocalOutputLimit);
  syncLocalOutputLimit();

  const save = async (reset = false) => {
    const numericInputs = [contextInput, outputInput, temperatureInput, topPInput, topKInput, repeatPenaltyInput]
      .filter((input) => input && !input.disabled);
    if (!reset && numericInputs.some((input) => input.value === '' || !input.checkValidity())) {
      const invalid = numericInputs.find((input) => input.value === '' || !input.checkValidity());
      if (invalid) invalid.reportValidity();
      toast('Check the highlighted parameter value.', 'err');
      return;
    }
    const overrides = reset ? undefined : {
      model: params.model,
      contextWindow: Number(contextInput.value),
      maxOutputTokens: Number(outputInput.value),
      temperature: preset.capabilities.temperature ? Number(temperatureInput.value) : null,
      topP: topPInput ? Number(topPInput.value) : null,
      topK: topKInput ? Number(topKInput.value) : null,
      repeatPenalty: repeatPenaltyInput ? Number(repeatPenaltyInput.value) : null,
      reasoningEffort: params.reasoningEffort,
      jsonMode: jsonInput ? jsonInput.value : null,
      contextMode: contextModeInput ? contextModeInput.value : null,
    };
    info.textContent = 'Saving…';
    try {
      const next = await api.applyLlmPreset({
        role: role === 'local' ? 'local' : 'global',
        presetId: preset.id,
        provider: preset.provider,
        overrides,
      });
      Object.assign(ctx.settings, next);
      toast(reset ? 'Recommended parameters restored.' : 'Custom LLM parameters saved.', 'ok');
      rebuild();
    } catch (err) {
      info.textContent = err.message;
      info.style.color = 'var(--red)';
      toast(err.message, 'err');
    }
  };

  const fields = [
    field('Context window', contextInput, preset.capabilities.contextWindowConfigurable
      ? preset.provider === 'lmstudio'
        ? 'Match the context used when loading the model in LM Studio.'
        : preset.provider === 'omlx'
          ? 'Keep this within the model context reported by oMLX.'
          : 'Maximum prompt and response context for this local model.'
      : 'Model capability; hosted providers do not change it per request.'),
    field('Max output tokens', outputInput,
      preset.provider === 'codex'
        ? 'Saved for API mode; the ChatGPT subscription backend manages this limit.'
        : preset.requestLimits && preset.requestLimits.maxOutputContextFraction === 0.5
          ? 'Capped at half the configured context so prompt and output fit together.'
          : preset.requestLimits && preset.requestLimits.maxOutputContextFraction === 1
            ? 'Cannot exceed the configured context window.'
            : null),
    field('Temperature', temperatureInput, preset.capabilities.temperature ? null : 'Omitted because this model/provider does not accept sampling overrides.'),
    topPInput ? field('Top P', topPInput) : null,
    topKInput ? field('Top K', topKInput) : null,
    repeatPenaltyInput ? field('Repeat penalty', repeatPenaltyInput) : null,
    jsonInput ? field('JSON output mode', jsonInput) : null,
    contextModeInput ? field('Context overflow', contextModeInput) : null,
  ];

  return el('details', { class: 'preset-customize' }, [
    el('summary', {}, 'Customize parameters'),
    el('div', { class: 'preset-customize-body' }, [
      el('div', { class: 'preset-param-grid' }, fields),
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', onclick: () => save(false) }, 'Save customization'),
        preset.id !== 'custom' ? el('button', { onclick: () => save(true) }, 'Reset to recommended') : null,
      ]),
      info,
    ]),
  ]);
}

function hostedConnection(ctx, provider) {
  return provider === 'codex' ? codexConnection(ctx) : claudeConnection(ctx);
}

function codexConnection(ctx) {
  const c = ctx.codex || { connected: false };
  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });
  const status = c.connected
    ? `Connected · token ${c.maskedToken || '••••'}${c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleString()}` : ''}`
    : 'Not connected. Sign in to use this hosted preset.';
  const signIn = el('button', { class: 'primary', onclick: async () => {
    try {
      const { authorizeUrl } = await api.startCodexLogin();
      window.location.href = authorizeUrl;
    } catch (err) { toast(err.message, 'err'); }
  } }, c.connected ? 'Re-authenticate' : 'Sign in with ChatGPT');
  const buttons = [signIn];
  if (c.connected) {
    buttons.push(
      el('button', { onclick: async () => {
        info.textContent = 'Testing…';
        try { const r = await api.testCodex(); info.textContent = `Connection OK · ${r.model || c.model}`; info.style.color = 'var(--green)'; }
        catch (err) { info.textContent = err.message; info.style.color = 'var(--red)'; }
      } }, 'Test connection'),
      el('button', { class: 'danger', onclick: async () => {
        try { await api.logoutCodex(); toast('Signed out of Codex.'); renderSettings(clear(ctx.view)); }
        catch (err) { toast(err.message, 'err'); }
      } }, 'Sign out')
    );
  }
  return el('div', { class: 'preset-connection' }, [
    el('div', { class: `preset-status ${c.connected ? 'ok' : 'warn'}` }, status),
    el('div', { class: 'row' }, buttons),
    info,
  ]);
}

function claudeConnection(ctx) {
  const c = ctx.claude || { connected: false };
  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });
  const codeInput = el('input', { placeholder: 'Paste code#state from Anthropic', style: 'flex:1;min-width:200px' });
  const status = c.connected
    ? `Connected · token ${c.maskedToken || '••••'}${c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleString()}` : ''}`
    : 'Not connected. Sign in to use this hosted preset.';
  const signIn = el('button', { class: 'primary', onclick: async () => {
    const popup = window.open('about:blank', '_blank');
    if (!popup) return toast('Popup blocked. Allow popups for this app and try again.', 'err');
    popup.opener = null;
    try {
      const { authorizeUrl } = await api.startClaudeLogin();
      popup.location.href = authorizeUrl;
      info.textContent = 'Approve in the opened tab, then paste the returned code below.';
    } catch (err) { popup.close(); toast(err.message, 'err'); }
  } }, c.connected ? 'Re-authenticate' : 'Sign in with Claude');
  const buttons = [signIn];
  if (c.connected) {
    buttons.push(
      el('button', { onclick: async () => {
        info.textContent = 'Testing…';
        try { const r = await api.testClaude(); info.textContent = `Connection OK · ${r.model}`; info.style.color = 'var(--green)'; }
        catch (err) { info.textContent = err.message; info.style.color = 'var(--red)'; }
      } }, 'Test connection'),
      el('button', { class: 'danger', onclick: async () => {
        try { await api.logoutClaude(); toast('Signed out of Claude.'); renderSettings(clear(ctx.view)); }
        catch (err) { toast(err.message, 'err'); }
      } }, 'Sign out')
    );
  }
  return el('div', { class: 'preset-connection' }, [
    el('div', { class: `preset-status ${c.connected ? 'ok' : 'warn'}` }, status),
    el('div', { class: 'row' }, buttons),
    el('div', { class: 'row claude-code-row' }, [
      codeInput,
      el('button', { onclick: async () => {
        if (!codeInput.value.trim()) return toast('Paste the code first.', 'err');
        info.textContent = 'Completing sign-in…';
        try { await api.exchangeClaude(codeInput.value.trim()); toast('Signed in to Claude.', 'ok'); renderSettings(clear(ctx.view)); }
        catch (err) { info.textContent = err.message; info.style.color = 'var(--red)'; }
      } }, 'Complete sign-in'),
    ]),
    info,
  ]);
}

/* ------------------------------- Role ----------------------------------- */

function roleSection({ members, assumedRole, view }) {
  const select = el(
    'select',
    {},
    [el('option', { value: '' }, '— select a member —')].concat(
      members.map((m) => el('option', { value: m.id, selected: assumedRole && assumedRole.id === m.id, dataset: { userContent: 'true' } }, `${m.name} (${m.email})`))
    )
  );

  const notify = () => window.dispatchEvent(new Event('lm:role-changed'));

  const assumeBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      if (!select.value) return toast('Pick a member first.', 'err');
      try {
        await api.assumeRole(select.value);
        toast('Role assumed.', 'ok');
        notify();
        renderSettings(clear(view));
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, 'Assume role');

  const clearBtn = el('button', {
    onclick: async () => {
      await api.clearRole();
      toast('Role cleared.');
      notify();
      renderSettings(clear(view));
    },
  }, 'Clear');

  return section('Assume Role', assumedRole ? `Acting as ${assumedRole.name}` : 'No role assumed', Boolean(!assumedRole), [
    el('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, 'Act as a workspace member. Enrichment claims open projects for the assumed role, which also shows in the top toolbar.'),
    assumedRole
      ? el('div', { class: 'row', style: 'margin-bottom:12px' }, [
          el('span', { class: 'avatar' }, (assumedRole.name || '?').slice(0, 2).toUpperCase()),
          el('div', { dataset: { userContent: 'true' } }, [el('div', { style: 'font-weight:600' }, assumedRole.name), el('div', { class: 'muted', style: 'font-size:12px' }, assumedRole.email || '')]),
        ])
      : null,
    field('Member', select),
    el('div', { class: 'row' }, [assumeBtn, assumedRole ? clearBtn : null]),
  ]);
}

/* --------------------------- Multi-label dropdown ----------------------- */

function labelDropdown(available, selected) {
  const sel = new Set(selected);
  // Include any already-selected labels that aren't in the fetched list.
  const options = [...new Set([...available, ...selected])].sort((a, b) => a.localeCompare(b));

  const panelId = `settings-labels-${++fieldSequence}`;
  const trigger = el('button', {
    type: 'button', class: 'ms-trigger', 'aria-haspopup': 'true',
    'aria-expanded': 'false', 'aria-controls': panelId, dataset: { userContent: 'true' },
  }, '');
  const panel = el('div', { class: 'ms-panel', id: panelId, hidden: true, role: 'group', 'aria-label': 'Project labels' });
  const wrap = el('div', { class: 'ms' }, [trigger, panel]);

  const refresh = () => {
    trigger.textContent = sel.size ? [...sel].join(', ') : 'Any label (all open projects)';
  };

  if (!options.length) {
    panel.append(el('div', { class: 'muted', style: 'padding:8px' }, 'No project labels found in Linear.'));
  }
  for (const name of options) {
    const cb = el('input', { type: 'checkbox', style: 'width:auto', ...(sel.has(name) ? { checked: 'checked' } : {}) });
    cb.addEventListener('change', () => {
      if (cb.checked) sel.add(name);
      else sel.delete(name);
      refresh();
    });
    panel.append(el('label', { class: 'ms-item', dataset: { userContent: 'true' } }, [cb, el('span', {}, name)]));
  }

  const setOpen = (open) => {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  trigger.addEventListener('click', () => {
    setOpen(panel.hidden);
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      trigger.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (wrap.isConnected && !wrap.contains(e.target)) setOpen(false);
  });

  refresh();
  return { element: wrap, get: () => [...sel] };
}

/* ---------------------------- Deep Agent config ------------------------- */

function agentSection({ config, intervals, labels, view }) {
  const inputs = {};
  const num = (key, label, min, max) => {
    const input = el('input', { type: 'number', min: String(min), max: String(max), value: String(config[key]) });
    inputs[key] = () => Number(input.value);
    return field(label, input);
  };
  const toggle = (key, label) => {
    const input = el('input', { type: 'checkbox', style: 'width:auto', ...(config[key] ? { checked: 'checked' } : {}) });
    inputs[key] = () => input.checked;
    return el('label', { class: 'row', style: 'gap:8px;cursor:pointer;margin-bottom:8px' }, [input, el('span', {}, label)]);
  };

  const intervalSelect = el(
    'select',
    {},
    intervals.map((m) => el('option', { value: String(m), selected: Number(m) === Number(config.intervalMinutes) }, `${m} minutes`))
  );
  const labelsCtl = labelDropdown(labels, config.enrichLabels || []);

  const saveBtn = el('button', { class: 'primary' }, 'Save agent config');
  saveBtn.addEventListener('click', async () => {
    const payload = {
      enrichLabels: labelsCtl.get(),
      intervalMinutes: Number(intervalSelect.value),
      parallelProcessing: inputs.parallelProcessing(),
      maxConcurrentCoders: inputs.maxConcurrentCoders(),
      maxProjectsPerRun: inputs.maxProjectsPerRun(),
      maxMilestones: inputs.maxMilestones(),
      maxIssuesPerMilestone: inputs.maxIssuesPerMilestone(),
      scheduleEnabled: inputs.scheduleEnabled(),
      autoAssignLead: inputs.autoAssignLead(),
      autoLabelNewProjects: inputs.autoLabelNewProjects(),
      createIssues: inputs.createIssues(),
      addDependencies: inputs.addDependencies(),
    };
    try {
      await api.saveAgentConfig(payload);
      toast('Agent config saved.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  return section('Deep Agent', 'Labels, schedule & limits', false, [
    field('Enrich projects with labels', labelsCtl.element, 'Open (no-lead) projects carrying ANY selected label are auto-enriched. Select none to enrich all open projects.'),
    el('div', { class: 'grid settings-agent-grid' }, [
      field('Run scheduler every', intervalSelect),
      num('parallelProcessing', 'Parallel processing', 1, 8),
      num('maxConcurrentCoders', 'Max concurrent coders', 1, 8),
      num('maxProjectsPerRun', 'Max projects / run', 1, 20),
      num('maxMilestones', 'Max milestones', 1, 12),
      num('maxIssuesPerMilestone', 'Max issues / milestone', 0, 12),
    ]),
    el('div', { style: 'margin:6px 0 12px' }, [
      toggle('scheduleEnabled', 'Run scheduler'),
      toggle('autoAssignLead', 'Assign assumed role as project lead'),
      toggle('autoLabelNewProjects', 'Auto-attach enrich labels to new projects'),
      toggle('createIssues', 'Create issues per milestone'),
      toggle('addDependencies', 'Add issue dependencies (LLM)'),
    ]),
    saveBtn,
  ]);
}
