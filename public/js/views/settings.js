import { api } from '../api.js';
import { el, clear, toast, loading } from '../dom.js';

export async function renderSettings(view) {
  view.append(loading('Loading settings…'));

  const [settings, configRes, modelsRes, labelsRes, membersRes, roleRes, ollamaRes, lmstudioRes, codexRes, claudeRes] = await Promise.all([
    api.getSettings(),
    api.getAgentConfig(),
    api.getAgentModels(),
    api.getAgentLabels().catch(() => ({ labels: [] })),
    api.getMembers().catch(() => ({ members: [] })),
    api.getAssumedRole().catch(() => ({ assumedRole: null })),
    api.getOllamaModels().catch(() => ({ models: [], reachable: false })),
    api.getLmstudioModels().catch(() => ({ models: [], reachable: false })),
    api.getCodexStatus().catch(() => ({ connected: false })),
    api.getClaudeStatus().catch(() => ({ connected: false })),
  ]);

  clear(view).append(
    el('div', { class: 'page-head' }, [el('h1', {}, 'Settings')]),
    keysSection(settings),
    llmSection({
      settings,
      ollamaModels: ollamaRes.models || [],
      reachable: ollamaRes.reachable,
      lmstudioModels: lmstudioRes.models || [],
      lmstudioReachable: lmstudioRes.reachable,
      codex: codexRes,
      claude: claudeRes,
      view,
    }),
    roleSection({ members: membersRes.members || [], assumedRole: roleRes.assumedRole, view }),
    agentSection({
      config: configRes.config,
      intervals: modelsRes.intervals || [5, 10, 15],
      labels: labelsRes.labels || [],
      view,
    })
  );
}

/* --------------------------- Collapsible box ---------------------------- */

function section(title, subtitle, open, children) {
  return el('details', { class: 'section', ...(open ? { open: 'open' } : {}) }, [
    el('summary', {}, [
      el('span', {}, title),
      subtitle ? el('span', { class: 'section-sub' }, subtitle) : null,
    ]),
    el('div', { class: 'section-body' }, children),
  ]);
}

const field = (label, control, hint) =>
  el('div', { class: 'field' }, [
    el('label', {}, label),
    control,
    hint ? el('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px' }, hint) : null,
  ]);

const pwd = (placeholder) => el('input', { type: 'password', autocomplete: 'off', placeholder });

/* ------------------------- Keys & connection ---------------------------- */

function keysSection(settings) {
  const status = el('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' });

  const linearInput = pwd(settings.hasKey ? `Saved: ${settings.maskedKey}` : 'lin_api_…');
  const githubInput = pwd(settings.hasGithubToken ? `Saved: ${settings.maskedGithubToken}` : 'github_pat_… / ghp_…');
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
      if (githubInput.value.trim()) {
        const gr = await api.saveGithubToken(githubInput.value.trim());
        githubInput.value = '';
        githubInput.placeholder = gr.hasGithubToken ? `Saved: ${gr.maskedGithubToken}` : 'github_pat_… / ghp_…';
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
    el('div', { class: 'subhead' }, 'GitHub (code-writer)'),
    field('GitHub Token', githubInput, [
      'Fine-grained PAT with Contents + Pull requests write on the code repo. Used by the code-writer to clone/push; stored server-side, never returned.',
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

/* ------------------------------- Deep Agent LLM ------------------------- */

function llmSection({ settings, ollamaModels, reachable, lmstudioModels, lmstudioReachable, codex, claude, view }) {
  const provider = settings.llmProvider || 'ollama';

  // Provider selector — switches which provider the deep agent uses.
  const providerSelect = el('select', {}, [
    el('option', { value: 'ollama', selected: provider === 'ollama' }, 'Ollama (local)'),
    el('option', { value: 'lmstudio', selected: provider === 'lmstudio' }, 'LM Studio (local)'),
    el('option', { value: 'codex', selected: provider === 'codex' }, 'Codex (OpenAI · OAuth)'),
    el('option', { value: 'claude', selected: provider === 'claude' }, 'Claude (Anthropic · OAuth)'),
  ]);
  providerSelect.addEventListener('change', async () => {
    try {
      await api.setProvider(providerSelect.value);
      toast(`Active provider: ${providerSelect.value}.`, 'ok');
      window.dispatchEvent(new Event('lm:connection-changed'));
      renderSettings(clear(view));
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  let subtitle;
  if (provider === 'codex') subtitle = `Codex · ${codex && codex.model ? codex.model : 'not signed in'}`;
  else if (provider === 'claude') subtitle = `Claude · ${claude && claude.connected ? claude.model : 'not signed in'}`;
  else if (provider === 'lmstudio') subtitle = settings.lmstudioModel ? `LM Studio · ${settings.lmstudioModel}` : 'LM Studio · not set';
  else subtitle = settings.ollamaModel || 'Ollama · not set';

  let incomplete;
  if (provider === 'codex') incomplete = Boolean(!codex.connected);
  else if (provider === 'claude') incomplete = Boolean(!claude.connected);
  else if (provider === 'lmstudio') incomplete = !settings.lmstudioModel;
  else incomplete = !settings.ollamaModel;

  return section('Deep Agent LLM', subtitle, incomplete, [
    el('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, 'Choose which model backs the business-owner deep agent. Ollama and LM Studio run fully local; Codex and Claude use "Sign in with ChatGPT / Claude" OAuth flows (no API key pasted — tokens stay server-side).'),
    field('Active provider', providerSelect),
    el('div', { class: 'subhead' }, 'Ollama (local)'),
    ...ollamaFields({ settings, ollamaModels, reachable }),
    el('div', { class: 'subhead' }, 'LM Studio (local)'),
    ...lmstudioFields({ settings, lmstudioModels, reachable: lmstudioReachable }),
    el('div', { class: 'subhead' }, 'Codex (OpenAI · OAuth)'),
    codexBlock({ codex, view }),
    el('div', { class: 'subhead' }, 'Claude (Anthropic · OAuth)'),
    claudeBlock({ claude, view }),
  ]);
}

/** Ollama configuration controls (returns an array of field elements). */
function ollamaFields({ settings, ollamaModels, reachable }) {
  const hostInput = el('input', { value: settings.ollamaHost || '', placeholder: 'http://localhost:11434' });

  // Model: dropdown of detected models (+ the current value), else free text.
  const detected = [...new Set([...(ollamaModels || []), ...(settings.ollamaModel ? [settings.ollamaModel] : [])])];
  const modelControl = detected.length
    ? el('select', {}, [el('option', { value: '' }, '— select a model —')].concat(
        detected.map((m) => el('option', { value: m, selected: m === settings.ollamaModel }, m))
      ))
    : el('input', { value: settings.ollamaModel || '', placeholder: 'e.g. llama3.1' });

  const ctxInput = el('input', { type: 'number', min: '512', max: '131072', value: String(settings.ollamaContextWindow || 8192) });
  const tokInput = el('input', { type: 'number', min: '128', max: '32768', value: String(settings.ollamaNumTokens || 8192) });
  const jsonSelect = jsonModeSelect(
    [
      ['json', 'Constrained (format: json)'],
      ['text', 'Prompt-only (text)'],
    ],
    settings.ollamaJsonMode || 'json'
  );
  const info = el('div', { class: 'muted', style: 'margin-top:10px;font-size:13px' });

  const save = async () => {
    try {
      const res = await api.saveLlm({
        ollamaHost: hostInput.value.trim(),
        ollamaModel: modelControl.value.trim(),
        ollamaContextWindow: Number(ctxInput.value),
        ollamaNumTokens: Number(tokInput.value),
        ollamaJsonMode: jsonSelect.value,
      });
      hostInput.value = res.ollamaHost;
      info.textContent = res.ollamaModel
        ? `Saved. Using ${res.ollamaModel} at ${res.ollamaHost}.`
        : 'Saved. Select a model to enable enrichment.';
      info.style.color = 'var(--green)';
      toast('LLM settings saved.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const reachNote = reachable
    ? `Detected ${ollamaModels.length} local model(s).`
    : 'Ollama not reachable at this host — start Ollama or fix the host, then reload.';

  return [
    el('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, 'Local inference — choose a model that supports tool-calling (e.g. llama3.1, qwen2.5, gpt-oss). No API key needed.'),
    field('Ollama Host', hostInput, 'Local endpoint, e.g. http://localhost:11434.'),
    field('Model', modelControl, reachNote),
    el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' }, [
      field('Context window (num_ctx)', ctxInput),
      field('Num tokens (num_predict)', tokInput),
    ]),
    field('JSON output mode', jsonSelect, 'How structured plans are constrained. Use "Prompt-only" if a model rejects constrained JSON.'),
    el('div', { class: 'row' }, [el('button', { class: 'primary', onclick: save }, 'Save Ollama settings')]),
    info,
  ];
}

/** A <select> of [value, label] JSON-mode options with `current` pre-selected. */
function jsonModeSelect(options, current) {
  return el(
    'select',
    {},
    options.map(([value, label]) => el('option', { value, selected: value === current }, label))
  );
}

/** LM Studio configuration controls (returns an array of field elements). */
function lmstudioFields({ settings, lmstudioModels, reachable }) {
  const hostInput = el('input', { value: settings.lmstudioHost || '', placeholder: 'http://localhost:1234' });

  // Model: dropdown of detected models (+ the current value), else free text.
  const detected = [...new Set([...(lmstudioModels || []), ...(settings.lmstudioModel ? [settings.lmstudioModel] : [])])];
  const modelControl = detected.length
    ? el('select', {}, [el('option', { value: '' }, '— select a model —')].concat(
        detected.map((m) => el('option', { value: m, selected: m === settings.lmstudioModel }, m))
      ))
    : el('input', { value: settings.lmstudioModel || '', placeholder: 'e.g. qwen2.5-7b-instruct' });

  const tokInput = el('input', { type: 'number', min: '128', max: '32768', value: String(settings.lmstudioNumTokens || 16000) });
  const jsonSelect = jsonModeSelect(
    [
      ['text', 'Prompt-only (text) — most compatible'],
      ['json_object', 'OpenAI json_object'],
      ['json_schema', 'Structured (json_schema)'],
    ],
    settings.lmstudioJsonMode || 'text'
  );
  const info = el('div', { class: 'muted', style: 'margin-top:10px;font-size:13px' });

  const save = async () => {
    try {
      const res = await api.saveLmstudio({
        lmstudioHost: hostInput.value.trim(),
        lmstudioModel: modelControl.value.trim(),
        lmstudioNumTokens: Number(tokInput.value),
        lmstudioJsonMode: jsonSelect.value,
      });
      hostInput.value = res.lmstudioHost;
      info.textContent = res.lmstudioModel
        ? `Saved. Using ${res.lmstudioModel} at ${res.lmstudioHost}.`
        : 'Saved. Select a model to enable enrichment.';
      info.style.color = 'var(--green)';
      toast('LM Studio settings saved.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const reachNote = reachable
    ? `Detected ${lmstudioModels.length} model(s).`
    : 'LM Studio not reachable at this host — start the LM Studio server or fix the host, then reload.';

  return [
    el('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, 'Local inference via LM Studio\'s OpenAI-compatible server. Load a tool-capable model in LM Studio and start its server (Developer → Start Server). Use this for models not available in Ollama. No API key needed.'),
    field('LM Studio Host', hostInput, 'Local endpoint, e.g. http://localhost:1234.'),
    field('Model', modelControl, reachNote),
    field('Num tokens (max_tokens)', tokInput, 'Output budget. Context length is set when you load the model in LM Studio.'),
    field('JSON output mode', jsonSelect, 'Some engines reject json_object — switch to "Structured" or "Prompt-only" if plans fail with a response_format error.'),
    el('div', { class: 'row' }, [el('button', { class: 'primary', onclick: save }, 'Save LM Studio settings')]),
    info,
  ];
}

/** Codex (OpenAI · OAuth) block. */
function codexBlock({ codex, view }) {
  const c = codex || { connected: false };
  const info = el('div', { class: 'muted', style: 'margin-top:10px;font-size:13px' });

  const modelInput = el('input', { value: c.configuredModel || '', placeholder: c.defaultModel || 'gpt-5-codex' });
  const tokInput = el('input', { type: 'number', min: '128', max: '32768', value: String(c.maxTokens || 4096) });

  const saveBtn = el('button', {
    onclick: async () => {
      try {
        await api.saveCodex({ codexModel: modelInput.value.trim(), codexMaxTokens: Number(tokInput.value) });
        toast('Codex settings saved.', 'ok');
        window.dispatchEvent(new Event('lm:connection-changed'));
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, 'Save Codex settings');

  const signInBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      try {
        const { authorizeUrl } = await api.startCodexLogin();
        // Top-level navigation to the provider's authorize page.
        window.location.href = authorizeUrl;
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, c.connected ? 'Re-authenticate' : 'Sign in with ChatGPT');

  const testBtn = el('button', {
    onclick: async () => {
      info.textContent = 'Testing…';
      try {
        const r = await api.testCodex();
        info.textContent = `Token OK${typeof r.models === 'number' ? ` — ${r.models} model(s) visible.` : '.'}`;
        info.style.color = 'var(--green)';
      } catch (err) {
        info.textContent = err.message;
        info.style.color = 'var(--red)';
      }
    },
  }, 'Test connection');

  const signOutBtn = el('button', {
    class: 'danger',
    onclick: async () => {
      try {
        await api.logoutCodex();
        toast('Signed out of Codex.');
        window.dispatchEvent(new Event('lm:connection-changed'));
        renderSettings(clear(view));
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, 'Sign out');

  const status = el('div', { class: 'muted', style: 'font-size:13px;margin:2px 0 10px' });
  if (c.connected) {
    const exp = c.expiresAt ? new Date(c.expiresAt).toLocaleString() : 'unknown';
    status.textContent = `Signed in (token ${c.maskedToken || '••••'}, expires ${exp}). Model: ${c.model}.`;
    status.style.color = 'var(--green)';
  } else {
    status.textContent = 'Not signed in. Uses OpenAI via OAuth (Authorization Code + PKCE); tokens are stored server-side only.';
  }

  const buttons = c.connected ? [signInBtn, testBtn, saveBtn, signOutBtn] : [signInBtn, saveBtn];

  return el('div', {}, [
    status,
    field('Model', modelInput, `OpenAI model id. Default: ${c.defaultModel || 'gpt-5-codex'}.`),
    field('Num tokens (max_tokens)', tokInput),
    el('p', { class: 'muted', style: 'font-size:12px;margin:6px 0 0' }, `Redirect URI (must be registered with the OAuth client): ${c.redirectUri || ''}`),
    el('div', { class: 'row', style: 'margin-top:10px' }, buttons),
    info,
  ]);
}

function claudeBlock({ claude, view }) {
  const c = claude || { connected: false };
  const info = el('div', { class: 'muted', style: 'margin-top:10px;font-size:13px' });

  const modelInput = el('input', { value: c.configuredModel || '', placeholder: c.defaultModel || 'claude-opus-4-8' });
  const tokInput = el('input', { type: 'number', min: '128', max: '32768', value: String(c.maxTokens || 4096) });
  // Paste-code flow: after approving, Anthropic shows a `code#state` value to paste back.
  const codeInput = el('input', { placeholder: 'Paste the code#state value from Anthropic', style: 'flex:1' });

  const saveBtn = el('button', {
    onclick: async () => {
      try {
        await api.saveClaude({ claudeModel: modelInput.value.trim(), claudeMaxTokens: Number(tokInput.value) });
        toast('Claude settings saved.', 'ok');
        window.dispatchEvent(new Event('lm:connection-changed'));
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, 'Save Claude settings');

  const signInBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      try {
        const { authorizeUrl } = await api.startClaudeLogin();
        // Open the provider's authorize page in a new tab; the operator pastes the code back here.
        window.open(authorizeUrl, '_blank', 'noopener');
        info.textContent = 'Approve in the opened tab, then paste the code Anthropic shows below and click "Complete sign-in".';
        info.style.color = '';
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, c.connected ? 'Re-authenticate' : 'Sign in with Claude');

  const exchangeBtn = el('button', {
    onclick: async () => {
      const code = codeInput.value.trim();
      if (!code) return toast('Paste the code first.', 'err');
      info.textContent = 'Completing sign-in…';
      try {
        await api.exchangeClaude(code);
        codeInput.value = '';
        toast('Signed in to Claude.', 'ok');
        window.dispatchEvent(new Event('lm:connection-changed'));
        renderSettings(clear(view));
      } catch (err) {
        info.textContent = err.message;
        info.style.color = 'var(--red)';
      }
    },
  }, 'Complete sign-in');

  const testBtn = el('button', {
    onclick: async () => {
      info.textContent = 'Testing…';
      try {
        const r = await api.testClaude();
        info.textContent = `Token OK — ${r.model}.`;
        info.style.color = 'var(--green)';
      } catch (err) {
        info.textContent = err.message;
        info.style.color = 'var(--red)';
      }
    },
  }, 'Test connection');

  const signOutBtn = el('button', {
    class: 'danger',
    onclick: async () => {
      try {
        await api.logoutClaude();
        toast('Signed out of Claude.');
        window.dispatchEvent(new Event('lm:connection-changed'));
        renderSettings(clear(view));
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, 'Sign out');

  const status = el('div', { class: 'muted', style: 'font-size:13px;margin:2px 0 10px' });
  if (c.connected) {
    const exp = c.expiresAt ? new Date(c.expiresAt).toLocaleString() : 'unknown';
    status.textContent = `Signed in (token ${c.maskedToken || '••••'}, expires ${exp}). Model: ${c.model}.`;
    status.style.color = 'var(--green)';
  } else {
    status.textContent = 'Not signed in. Uses your Claude subscription via OAuth (Authorization Code + PKCE); tokens are stored server-side only.';
  }

  const buttons = c.connected ? [signInBtn, testBtn, saveBtn, signOutBtn] : [signInBtn, saveBtn];

  return el('div', {}, [
    status,
    field('Model', modelInput, `Anthropic model id. Default: ${c.defaultModel || 'claude-opus-4-8'}.`),
    field('Num tokens (max_tokens)', tokInput),
    el('div', { class: 'row', style: 'margin-top:10px' }, [codeInput, exchangeBtn]),
    el('div', { class: 'row', style: 'margin-top:10px' }, buttons),
    info,
  ]);
}

/* ------------------------------- Role ----------------------------------- */

function roleSection({ members, assumedRole, view }) {
  const select = el(
    'select',
    {},
    [el('option', { value: '' }, '— select a member —')].concat(
      members.map((m) => el('option', { value: m.id, selected: assumedRole && assumedRole.id === m.id }, `${m.name} (${m.email})`))
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
          el('div', {}, [el('div', { style: 'font-weight:600' }, assumedRole.name), el('div', { class: 'muted', style: 'font-size:12px' }, assumedRole.email || '')]),
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

  const trigger = el('button', { type: 'button', class: 'ms-trigger' }, '');
  const panel = el('div', { class: 'ms-panel', hidden: true });
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
    panel.append(el('label', { class: 'ms-item' }, [cb, el('span', {}, name)]));
  }

  trigger.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (wrap.isConnected && !wrap.contains(e.target)) panel.hidden = true;
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
    el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' }, [
      field('Run scheduler every', intervalSelect),
      num('parallelProcessing', 'Parallel processing', 1, 8),
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
