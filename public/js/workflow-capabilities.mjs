/**
 * kagent capabilities for the workflow designer.
 *
 * The cluster decides which Harness, ModelConfig and RemoteMCPServer names
 * exist; this browser does not. `normalizeKagentSpec` accepts any DNS-shaped
 * name, so a typed-in one saves cleanly and only fails when the CR is applied —
 * with nothing in the error to say the name was never deployed. Reading the
 * namespace turns those fields from guesses into choices.
 *
 * The read is per organization and shared by every node inspector opened in the
 * same session: one agent node and forty cost the same one request. An
 * unanswered read is remembered rather than re-issued on every redraw — the
 * inspector re-renders whenever anything is edited, so a retry-per-render would
 * turn an unconfigured deployment into a request loop. "Read again" retries on
 * demand instead, which is what an operator who has just turned kagent on needs.
 */

export const KAGENT_CAPABILITY_REASONS = Object.freeze([
  'not_read', 'kagent_not_configured', 'read_failed', 'kagent_capabilities_failed',
]);

const EMPTY = Object.freeze({
  enabled: false,
  reason: 'not_read',
  namespace: '',
  harnesses: [],
  modelConfigs: [],
  remoteMcpServers: [],
  agentTemplates: [],
});

function nameList(value) {
  const seen = [];
  for (const item of Array.isArray(value) ? value : []) {
    const name = String(item ?? '').trim();
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * @param {() => Promise<object>} read  resolves one GET of the capabilities
 *   route; injected so the cache and the failure path are testable without a
 *   browser or a cluster.
 */
export function createCapabilitiesReader({ read } = {}) {
  const settled = new Map();
  const refused = new Map();
  const pending = new Map();

  async function load(organizationId, { force = false } = {}) {
    const key = String(organizationId || '');
    if (force) {
      settled.delete(key);
      refused.delete(key);
      pending.delete(key);
    }
    if (settled.has(key)) return settled.get(key);
    if (refused.has(key)) return refused.get(key);
    if (pending.has(key)) return pending.get(key);

    const request = (async () => {
      try {
        const payload = await read();
        const value = {
          enabled: Boolean(payload && payload.enabled),
          reason: payload && payload.reason ? String(payload.reason) : (payload && payload.enabled ? '' : 'kagent_not_configured'),
          namespace: String((payload && payload.namespace) || ''),
          harnesses: nameList(payload && payload.harnesses),
          modelConfigs: nameList(payload && payload.modelConfigs),
          remoteMcpServers: nameList(payload && payload.remoteMcpServers),
          agentTemplates: nameList(payload && payload.agentTemplates),
          error: payload && payload.detail ? String(payload.detail) : '',
        };
        // Only a read that answered with names is worth keeping for the whole
        // session; a refusal is remembered too (so nothing re-asks it on every
        // redraw) but is dropped by force, since the cluster may have changed.
        (value.enabled ? settled : refused).set(key, value);
        return value;
      } catch (cause) {
        const value = { ...EMPTY, reason: 'read_failed', error: String((cause && cause.message) || cause) };
        refused.set(key, value);
        return value;
      } finally {
        pending.delete(key);
      }
    })();

    pending.set(key, request);
    return request;
  }

  return {
    load,
    peek: (organizationId) => {
      const key = String(organizationId || '');
      return settled.get(key) || refused.get(key) || null;
    },
    inFlight: (organizationId) => pending.has(String(organizationId || '')),
    /** Retry after the operator changes the deployment, or a new org is opened. */
    forget: (organizationId) => {
      const key = String(organizationId || '');
      settled.delete(key);
      refused.delete(key);
      pending.delete(key);
    },
  };
}

/**
 * Cluster names first, then the platform's current runtime images, then the
 * platform's own static list underneath: a harness that exists in the
 * namespace is the one a publish will accept, the global image registry says
 * what the platform ships, while the static list is what an operator is about
 * to install. Marked so the card can say which is which rather than
 * presenting an unlabelled union.
 */
export function harnessChoices(caps, platformHarnesses = [], globalImages = []) {
  const cluster = nameList(caps && caps.harnesses);
  const globalNames = (Array.isArray(globalImages) ? globalImages : [])
    .map((row) => String((row && row.runtime) || '').trim())
    .filter(Boolean);
  return [
    ...cluster.map((value) => ({ value, label: value, source: 'cluster' })),
    ...globalNames
      .filter((value) => !cluster.includes(value))
      .map((value) => ({ value, label: value, source: 'global' })),
    ...nameList(platformHarnesses)
      .filter((value) => !cluster.includes(value) && !globalNames.includes(value))
      .map((value) => ({ value, label: value, source: 'platform' })),
  ];
}

/** The empty entry has to say why it is empty: nothing read yet is not the
 * same fact as a namespace that genuinely has no ModelConfig. */
export function modelConfigEmptyLabel(caps) {
  if (!caps) return 'Reading the cluster…';
  if (!caps.enabled) return 'No ModelConfig names available (kagent not configured)';
  return caps.modelConfigs.length
    ? 'Cluster default (from the Harness)'
    : 'No ModelConfig in this namespace';
}

/** A ModelConfig is only ever a cluster object, so an empty list says so. */
export function modelConfigChoices(caps) {
  return nameList(caps && caps.modelConfigs).map((value) => ({ value, label: value, source: 'cluster' }));
}

export function mcpChoices(caps) {
  return nameList(caps && caps.remoteMcpServers).map((value) => ({ value, label: value, source: 'cluster' }));
}

export function capabilitiesSummary(caps) {
  if (!caps || caps.reason === 'not_read') return 'Reading the cluster…';
  if (!caps.enabled) {
    return caps.reason === 'read_failed'
      ? `The cluster could not be read (${caps.error || 'no response'}). Names are not validated until it answers.`
      : 'kagent is not configured for this deployment, so no cluster names are available. Saves still accept a binding; publish will answer 503.';
  }
  const counts = [
    `${caps.harnesses.length} harness`,
    `${caps.modelConfigs.length} ModelConfig`,
    `${caps.remoteMcpServers.length} RemoteMCPServer`,
  ];
  return `Namespace ${caps.namespace || 'kagent'} · ${counts.join(' · ')}`;
}

export const EMPTY_CAPABILITIES = EMPTY;

/**
 * The platform-wide component catalog (runtime images, plugin and skill
 * bundles) is identical for every organization, so one session-level read
 * covers the whole designer. A failed read is remembered like a refused
 * capabilities read — the inspector re-renders on every keystroke and must
 * not turn a dead endpoint into a request loop — and `force` retries it.
 */
export function createCatalogReader({ read } = {}) {
  let settled = null;
  let pending = null;

  function load({ force = false } = {}) {
    if (force) settled = null;
    if (settled) return Promise.resolve(settled);
    if (pending) return pending;
    const request = (async () => {
      try {
        const payload = await read();
        settled = {
          ok: true,
          harnesses: Array.isArray(payload && payload.harnesses) ? payload.harnesses : [],
          plugins: Array.isArray(payload && payload.plugins) ? payload.plugins : [],
          skills: Array.isArray(payload && payload.skills) ? payload.skills : [],
        };
      } catch (cause) {
        settled = { ok: false, error: String((cause && cause.message) || cause), harnesses: [], plugins: [], skills: [] };
      } finally {
        pending = null;
      }
      return settled;
    })();
    pending = request;
    return request;
  }

  return {
    load,
    peek: () => settled,
    forget: () => { settled = null; },
  };
}

/**
 * Model families from the global LLM preset catalog: each preset's provider
 * maps onto the designer's family vocabulary, so the dropdown offers the
 * families the platform actually ships models for, plus the static list for
 * anything saved before it (bedrock/vertexai stay selectable even though no
 * preset lands there).
 */
const PRESET_FAMILIES = Object.freeze({
  claude: 'anthropic',
  codex: 'openai',
  antigravity: 'gemini',
  qoder: 'qoder',
  ollama: 'byok',
  lmstudio: 'byok',
  omlx: 'byok',
  huggingface: 'byok',
});

export function presetFamily(preset) {
  return PRESET_FAMILIES[String((preset && preset.provider) || '')] || '';
}

export function modelFamilyChoices(presets, staticFamilies = []) {
  const items = [];
  for (const preset of Array.isArray(presets) ? presets : []) {
    const family = presetFamily(preset);
    if (family && !items.some((item) => item.value === family)) items.push({ value: family, label: family, source: 'global' });
  }
  for (const family of nameList(staticFamilies)) {
    if (!items.some((item) => item.value === family)) items.push({ value: family, label: family, source: 'platform' });
  }
  return items;
}

/** The concrete models behind one family, straight from the preset catalog. */
export function modelChoices(presets, family) {
  return (Array.isArray(presets) ? presets : [])
    .filter((preset) => family && presetFamily(preset) === family)
    .map((preset) => ({
      value: String(preset.id),
      label: `${preset.label || preset.id} · ${preset.model}`,
      source: 'global',
    }));
}
