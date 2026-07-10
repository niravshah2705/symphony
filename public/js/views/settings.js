import { api } from '../api.js';
import { el, clear, toast, loading } from '../dom.js';

export async function renderSettings(view) {
  view.append(loading('Loading settings…'));

  const [settings, presets, configRes, modelsRes, labelsRes, membersRes, roleRes, ollamaRes, lmstudioRes, codexRes, claudeRes] = await Promise.all([
    api.getSettings(),
    api.getLlmPresets(),
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

  // Two-column layout: keys + LLM on the left, role + agent config on the right.
  // Collapses to a single column on narrow screens (see .settings-grid).
  clear(view).append(
    el('div', { class: 'page-head' }, [el('h1', {}, 'Settings')]),
    el('div', { class: 'settings-grid' }, [
      el('div', { class: 'settings-col' }, [
        keysSection(settings),
        llmSection({
          settings,
          presets,
          ollamaModels: ollamaRes.models || [],
          reachable: ollamaRes.reachable,
          lmstudioModels: lmstudioRes.models || [],
          lmstudioReachable: lmstudioRes.reachable,
          codex: codexRes,
          claude: claudeRes,
          view,
        }),
      ]),
      el('div', { class: 'settings-col' }, [
        roleSection({ members: membersRes.members || [], assumedRole: roleRes.assumedRole, view }),
        agentSection({
          config: configRes.config,
          intervals: modelsRes.intervals || [5, 10, 15],
          labels: labelsRes.labels || [],
          view,
        }),
      ]),
    ])
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

function llmSection(ctx) {
  const container = el('div', { class: 'llm-section' });
  const rebuild = () => {
    const previous = container.firstElementChild;
    const wasOpen = previous && previous.tagName === 'DETAILS' ? previous.open : null;
    clear(container).append(buildLlmSection(ctx, rebuild));
    if (wasOpen === true && container.firstElementChild) container.firstElementChild.open = true;
  };

  rebuild();
  return container;
}

const PROVIDER_LABELS = Object.freeze({
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  codex: 'OpenAI · ChatGPT OAuth',
  claude: 'Anthropic · Claude OAuth',
});

function buildLlmSection(ctx, rebuild) {
  const localPreset = findPreset(ctx, ctx.settings.localLlmPresetId, 'local');
  const hostedPreset = findPreset(ctx, ctx.settings.hostedLlmPresetId, 'hosted');
  const localProvider = localPreset ? localPreset.provider : ctx.settings.localLlmProvider;
  const hostedProvider = hostedPreset ? hostedPreset.provider : ctx.settings.llmProvider;
  const localName = localPreset ? localPreset.label : `Custom ${PROVIDER_LABELS[ctx.settings.localLlmProvider] || ''}`;
  const hostedName = hostedPreset ? hostedPreset.label : `Custom ${PROVIDER_LABELS[ctx.settings.llmProvider] || ''}`;
  const incomplete = !currentParameters(ctx.settings, localProvider).model ||
    !currentParameters(ctx.settings, hostedProvider).model ||
    !providerConnected(ctx, localProvider) ||
    !providerConnected(ctx, hostedProvider);

  return section('Deep Agent LLM', `Local: ${localName} · Hosted: ${hostedName}`, incomplete, [
    el('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, 'Pick one recommended preset per route. Context, output, sampling, JSON, and reasoning values are applied together. Open “Customize parameters” only when you want to override them.'),
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

function providerConnected(ctx, provider) {
  if (provider === 'codex') return Boolean(ctx.codex && ctx.codex.connected);
  if (provider === 'claude') return Boolean(ctx.claude && ctx.claude.connected);
  return true;
}

function presetSlot(ctx, role, rebuild) {
  const deployment = role === 'local' ? 'local' : 'hosted';
  const presets = (ctx.presets.presets || []).filter((preset) => preset.deployment === deployment);
  const preset = findPreset(ctx, selectedPresetId(ctx.settings, role), deployment);
  const provider = preset ? preset.provider : roleProvider(ctx.settings, role);
  const params = currentParameters(ctx.settings, provider);
  const customized = Boolean(preset && presetCustomized(preset, params));
  const select = presetSelect(presets, preset ? preset.id : 'custom');

  select.addEventListener('change', async () => {
    const chosen = presets.find((item) => item.id === select.value);
    if (!chosen) return;
    select.disabled = true;
    try {
      const detected = detectedModels(ctx, chosen.provider);
      const installedMatch = findDetectedModel(chosen, detected);
      const overrides = installedMatch && installedMatch !== chosen.model ? { model: installedMatch } : undefined;
      const next = await api.applyLlmPreset({ role: role === 'local' ? 'local' : 'global', presetId: chosen.id, overrides });
      Object.assign(ctx.settings, next);
      toast(`${role === 'local' ? 'Local' : 'Hosted'} preset applied: ${chosen.label}.`, 'ok');
      rebuild();
    } catch (err) {
      select.disabled = false;
      select.value = preset ? preset.id : 'custom';
      toast(err.message, 'err');
    }
  });

  const heading = role === 'local' ? 'Local / XS tasks' : 'Hosted / planner + larger tasks';
  const description = role === 'local'
    ? provider === 'ollama' || provider === 'lmstudio'
      ? 'Runs fully on this machine through Ollama or LM Studio.'
      : 'Legacy custom route for XS tasks using a hosted OAuth provider.'
    : provider === 'codex' || provider === 'claude'
      ? 'Used by planning and every hosted or unlabeled coding task.'
      : 'Legacy custom planner route using a local inference server.';
  const status = presetAvailability(ctx, preset, provider, params.model, role, rebuild);
  const children = [
    el('div', { class: 'preset-card-head' }, [
      el('div', {}, [el('div', { class: 'preset-title' }, heading), el('div', { class: 'muted preset-route' }, description)]),
      customized ? el('span', { class: 'badge preset-custom-badge' }, 'Customized') : null,
    ]),
    field('Model preset', select),
  ];

  if (preset) {
    children.push(
      el('p', { class: 'preset-description' }, preset.description),
      parameterSummary(params),
      status,
      preset.requirements ? el('p', { class: 'muted preset-requirement' }, [
        preset.requirements,
        preset.sourceUrl ? ' ' : null,
        preset.sourceUrl ? el('a', { href: preset.sourceUrl, target: '_blank', rel: 'noopener', class: 'preset-doc-link' }, 'Model docs ↗') : null,
      ]) : null
    );
  } else {
    children.push(
      el('div', { class: 'preset-legacy-note' }, [
        el('strong', {}, `Custom ${PROVIDER_LABELS[provider] || provider} configuration`),
        el('span', {}, ' Choose a preset above to apply a complete recommended parameter set; your current values remain untouched until then.'),
      ]),
      status
    );
  }

  if (provider === 'codex' || provider === 'claude') {
    children.push(hostedConnection(ctx, provider));
  }
  const editorPreset = preset || customEditorPreset(provider, params, ctx.settings, deployment);
  if (editorPreset) children.push(parameterEditor(ctx, role, editorPreset, params, rebuild));

  return el('div', { class: `preset-card preset-card-${deployment}` }, children);
}

function customEditorPreset(provider, params, settings, deployment) {
  const isOllama = provider === 'ollama';
  const isLmstudio = provider === 'lmstudio';
  const isCodex = provider === 'codex';
  const adapter = isOllama
    ? ['ollama-think-effort', 'ollama-think-toggle'].includes(settings.ollamaReasoningAdapter) ? settings.ollamaReasoningAdapter : 'none'
    : isLmstudio
      ? settings.lmstudioReasoningAdapter === 'openai-compatible' ? 'openai-compatible' : 'none'
      : isCodex
        ? settings.codexReasoningAdapter === 'openai' ? 'openai' : 'none'
        : settings.claudeReasoningAdapter === 'anthropic-adaptive' ? 'anthropic-adaptive' : 'none';
  const efforts = isOllama
    ? adapter === 'ollama-think-effort' ? ['low', 'medium', 'high'] : adapter === 'ollama-think-toggle' ? ['none', 'medium'] : ['none']
    : isLmstudio
      ? adapter === 'openai-compatible' ? ['none', 'low', 'medium', 'high'] : ['none']
      : isCodex
        ? adapter === 'openai' ? ['none', 'low', 'medium', 'high', 'xhigh'] : ['none']
        : adapter === 'anthropic-adaptive' ? ['none', 'low', 'medium', 'high', 'xhigh', 'max'] : ['none'];
  const parameter = adapter === 'ollama-think-effort' || adapter === 'ollama-think-toggle'
    ? 'think'
    : adapter === 'openai-compatible'
      ? 'reasoning_effort'
      : adapter === 'openai'
        ? 'reasoning.effort'
        : adapter === 'anthropic-adaptive' ? 'thinking.type=adaptive + output_config.effort' : null;
  return {
    id: 'custom',
    provider,
    model: params.model,
    limits: {
      contextWindow: isOllama || isLmstudio ? 262144 : isCodex ? 1050000 : 1000000,
      maxOutputTokens: 128000,
    },
    requestLimits: {
      maxOutputContextFraction: isLmstudio ? 0.5 : isOllama ? 1 : null,
    },
    capabilities: {
      temperature: isOllama || isLmstudio || (isCodex && adapter === 'none'),
      contextWindowConfigurable: isOllama || isLmstudio,
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

function presetSelect(presets, selected) {
  const providers = [...new Set(presets.map((preset) => preset.provider))];
  const groups = providers.map((provider) =>
    el('optgroup', { label: PROVIDER_LABELS[provider] || provider }, presets
      .filter((preset) => preset.provider === provider)
      .map((preset) => el('option', { value: preset.id, selected: preset.id === selected }, `${preset.recommended ? '★ ' : ''}${preset.label}`)))
  );
  if (selected === 'custom') groups.unshift(el('option', { value: 'custom', selected: true }, 'Custom (current settings)'));
  return el('select', { class: 'preset-select' }, groups);
}

function detectedModels(ctx, provider) {
  if (provider === 'ollama') return ctx.ollamaModels || [];
  if (provider === 'lmstudio') return ctx.lmstudioModels || [];
  return [];
}

function normalizedModel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function modelMatchesPreset(preset, model) {
  const actual = normalizedModel(model);
  return [preset.model, ...(preset.modelPatterns || [])].some((pattern) => actual.includes(normalizedModel(pattern)));
}

function findDetectedModel(preset, models) {
  return (models || []).find((model) => modelMatchesPreset(preset, model)) || null;
}

function presetAvailability(ctx, preset, provider, model, role, rebuild) {
  if (provider !== 'ollama' && provider !== 'lmstudio') return null;
  const reachable = provider === 'ollama' ? ctx.reachable : ctx.lmstudioReachable;
  const models = detectedModels(ctx, provider);
  if (!reachable) {
    return el('div', { class: 'preset-status warn' }, `${PROVIDER_LABELS[provider]} is not reachable. Start its server, then reload Settings.`);
  }
  const installed = models.includes(model);
  const compatible = !installed && preset ? findDetectedModel(preset, models) : null;
  if (installed) return el('div', { class: 'preset-status ok' }, `Ready · ${model} detected`);
  if (compatible) {
    const useModel = el('button', { class: 'preset-inline-action' }, `Use ${compatible}`);
    useModel.addEventListener('click', async () => {
      useModel.disabled = true;
      try {
        const current = currentParameters(ctx.settings, provider);
        const next = await api.applyLlmPreset({
          role: role === 'local' ? 'local' : 'global',
          presetId: preset.id,
          // This action changes only the compatible model alias; keep any
          // advanced values the operator already customized on this preset.
          overrides: { ...current, model: compatible },
        });
        Object.assign(ctx.settings, next);
        toast(`Mapped ${preset.label} to ${compatible}.`, 'ok');
        rebuild();
      } catch (err) {
        useModel.disabled = false;
        toast(err.message, 'err');
      }
    });
    return el('div', { class: 'preset-status warn' }, [
      el('span', {}, `${model} is not loaded; a compatible model is available.`),
      useModel,
    ]);
  }
  return el('div', { class: 'preset-status warn' }, `${model || 'Model'} is not detected. Install/load it, or customize the compatible model id below.`);
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

function parameterSummary(params) {
  const temperature = typeof params.temperature === 'number' ? params.temperature : 'managed';
  return el('div', { class: 'preset-params' }, [
    el('span', { class: 'param-chip' }, `Context ${compactTokens(params.contextWindow)}`),
    el('span', { class: 'param-chip' }, `Output ${compactTokens(params.maxOutputTokens)}`),
    el('span', { class: 'param-chip' }, `Reasoning ${params.reasoningEffort}`),
    el('span', { class: 'param-chip' }, `Temperature ${temperature}`),
  ]);
}

function optionSelect(options, current) {
  return el('select', {}, options.map(([value, label]) => el('option', { value, selected: value === current }, label)));
}

function parameterEditor(ctx, role, preset, params, rebuild) {
  const models = detectedModels(ctx, preset.provider);
  const listId = `models-${role}-${preset.provider}`;
  const hostedPresetModel = preset.id !== 'custom' && (preset.provider === 'codex' || preset.provider === 'claude');
  const modelInput = el('input', {
    value: params.model || preset.model, list: listId, autocomplete: 'off',
    ...(hostedPresetModel ? { disabled: 'disabled' } : {}),
  });
  const modelControl = el('div', {}, [modelInput, el('datalist', { id: listId }, models.map((model) => el('option', { value: model }))) ]);
  const contextInput = el('input', {
    type: 'number', min: '512', max: String(preset.limits.contextWindow), value: String(params.contextWindow),
    ...(preset.capabilities.contextWindowConfigurable ? {} : { disabled: 'disabled' }),
  });
  const outputInput = el('input', {
    type: 'number', min: preset.provider === 'lmstudio' ? '256' : '128',
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
  const effortInput = optionSelect(
    preset.capabilities.reasoningEfforts.map((effort) => [effort, effort === 'none' ? 'Off' : effort === 'medium' && preset.capabilities.reasoningAdapter === 'ollama-think-toggle' ? 'On' : effort[0].toUpperCase() + effort.slice(1)]),
    params.reasoningEffort
  );
  const hostInput = params.host ? el('input', { value: params.host }) : null;
  const jsonInput = preset.provider === 'ollama'
    ? optionSelect([['json', 'Constrained JSON'], ['text', 'Prompt-only text']], params.jsonMode)
    : preset.provider === 'lmstudio'
      ? optionSelect([['text', 'Prompt-only text'], ['json_object', 'OpenAI json_object'], ['json_schema', 'Structured json_schema']], params.jsonMode)
      : null;
  const contextModeInput = preset.provider === 'lmstudio'
    ? optionSelect([['summarize', 'Summarize old turns'], ['trim', 'Trim old turns'], ['none', 'None']], params.contextMode)
    : null;
  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });

  const syncLocalOutputLimit = () => {
    const fraction = preset.requestLimits && preset.requestLimits.maxOutputContextFraction;
    if (!Number.isFinite(fraction)) return;
    const minimum = preset.provider === 'lmstudio' ? 256 : 128;
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
    if (!reset && (!modelInput.value.trim() || numericInputs.some((input) => input.value === '' || !input.checkValidity()))) {
      const invalid = numericInputs.find((input) => input.value === '' || !input.checkValidity());
      if (invalid) invalid.reportValidity();
      toast(!modelInput.value.trim() ? 'Model id is required.' : 'Check the highlighted parameter value.', 'err');
      return;
    }
    if (!reset && preset.id !== 'custom' && !modelMatchesPreset(preset, modelInput.value)) {
      toast(`Model id must stay in the ${preset.label} family. Choose its matching preset first.`, 'err');
      return;
    }
    const overrides = reset ? undefined : {
      model: modelInput.value.trim(),
      contextWindow: Number(contextInput.value),
      maxOutputTokens: Number(outputInput.value),
      temperature: preset.capabilities.temperature ? Number(temperatureInput.value) : null,
      topP: topPInput ? Number(topPInput.value) : null,
      topK: topKInput ? Number(topKInput.value) : null,
      repeatPenalty: repeatPenaltyInput ? Number(repeatPenaltyInput.value) : null,
      reasoningEffort: effortInput.value,
      jsonMode: jsonInput ? jsonInput.value : null,
      contextMode: contextModeInput ? contextModeInput.value : null,
      ...(hostInput ? { host: hostInput.value.trim() } : {}),
    };
    const hostChanged = Boolean(hostInput && hostInput.value.trim().replace(/\/$/, '') !== String(params.host || '').replace(/\/$/, ''));
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
      if (hostChanged) await renderSettings(clear(ctx.view));
      else rebuild();
    } catch (err) {
      info.textContent = err.message;
      info.style.color = 'var(--red)';
      toast(err.message, 'err');
    }
  };

  const fields = [
    hostInput ? field(`${PROVIDER_LABELS[preset.provider]} host`, hostInput) : null,
    field('Model id', modelControl, hostedPresetModel ? 'Model id is fixed because the reasoning and sampling capabilities are model-specific.' : models.length ? `${models.length} detected model(s) are available as suggestions.` : null),
    field('Context window', contextInput, preset.capabilities.contextWindowConfigurable ? 'For LM Studio, this must match the context used when loading the model.' : 'Model capability; hosted providers do not change it per request.'),
    field('Max output tokens', outputInput,
      preset.provider === 'codex'
        ? 'Saved for API mode; the ChatGPT subscription backend manages this limit.'
        : preset.requestLimits && preset.requestLimits.maxOutputContextFraction === 0.5
          ? 'Capped at half the loaded context so prompt and output fit together.'
          : preset.requestLimits && preset.requestLimits.maxOutputContextFraction === 1
            ? 'Cannot exceed the configured context window.'
            : null),
    field('Temperature', temperatureInput, preset.capabilities.temperature ? null : 'Omitted because this model/provider does not accept sampling overrides.'),
    topPInput ? field('Top P', topPInput) : null,
    topKInput ? field('Top K', topKInput) : null,
    repeatPenaltyInput ? field('Repeat penalty', repeatPenaltyInput) : null,
    field('Reasoning effort', effortInput, `Sent as ${preset.parameters.reasoning.parameter || 'provider default'}.`),
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
