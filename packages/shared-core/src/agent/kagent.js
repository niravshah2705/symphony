'use strict';

// Kagent runtime adapter — the control-plane client for the in-cluster agent
// CRDs (group api.kagent.dev, storage v1alpha3: agents, agenttemplates,
// harnesses, modelconfigs, remotemcpservers, egresspolicies).
//
// Placement follows the repo egress rules: this client lives in the gateway
// control plane, NEVER in an agent container or in the orchestrator that
// dispatches them. It authenticates with a mounted Kubernetes service-account
// token; provider credentials stay behind ModelConfig apiKeySecret /
// RemoteMCPServer headersFrom references inside the cluster, so nothing here
// reads or writes Fleet secrets.
//
// Unconfigured cluster (the default) is inert: renders and saves still work,
// publish/list/report kagent_not_configured (HTTP 503 territory).

const fs = require('node:fs');
const https = require('node:https');

const { CONFIG } = require('../config.js');
const wfModel = require('../workflow/model.js');

const IN_CLUSTER_TOKEN = '/var/run/secrets/kubernetes.io/service-account/token';
const IN_CLUSTER_CA = '/var/run/secrets/kubernetes.io/service-account/ca.crt';
const SYSTEM_PROMPT_INLINE_MAX = 60_000;

const PLURALS = Object.freeze({
  agent: 'agents',
  agentTemplate: 'agenttemplates',
  harness: 'harnesses',
  modelConfig: 'modelconfigs',
  remoteMcpServer: 'remotemcpservers',
  egressPolicy: 'egresspolicies',
});

function dnsLabel(value, fallback = 'agent') {
  const slug = String(value || '').toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 63);
  return /^[a-z0-9]/.test(slug) ? slug : fallback;
}

function kagentConfig(config = CONFIG.KAGENT) {
  const inCluster = fs.existsSync(IN_CLUSTER_TOKEN);
  const apiUrl = config.apiUrl || (inCluster ? 'https://kubernetes.default.svc' : '');
  if (!config.enabled || !apiUrl) return null;
  const tokenFile = config.tokenFile || (inCluster ? IN_CLUSTER_TOKEN : '');
  const caFile = config.caFile || (inCluster ? IN_CLUSTER_CA : '');
  let token = '';
  let ca = null;
  try {
    if (tokenFile) token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (caFile && fs.existsSync(caFile)) ca = fs.readFileSync(caFile);
  } catch (_) {
    return null;
  }
  if (!token && !config.kubeconfig) return null;
  return { apiUrl, namespace: config.namespace || 'kagent', token, ca, timeoutMs: config.timeoutMs || 15000, group: config.group || 'api.kagent.dev', version: config.version || 'v1alpha3' };
}

function defaultRequest(cfg, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${cfg.apiUrl}${path}`);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      timeout: cfg.timeoutMs,
      ca: cfg.ca || undefined,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* keep text on status */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('kagent request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------------- rendering

/**
 * Render one agent profile (or v2 agent node) into the kagent CRs it implies.
 * `spec` is validated with the same CRD-faithful model the gateway persists:
 * skill/plugin sources must be immutable-pinned, tools map 1:1 onto
 * mcp{server}/subAgent bindings, and promptAppend text is COMPOSED into the
 * system prompt here — kagent surfaces skills as tools, it does not append
 * their prompts on its own.
 *
 * Returns { ok, agent, configMap?, harnessEnv?, warnings } or { ok:false, errors }.
 */
function renderAgentCrd(input, { namespace } = {}) {
  const id = dnsLabel(input && (input.id || input.refId));
  if (!id) return { ok: false, errors: ['Agent needs an id that maps to a Kubernetes name.'] };
  const rawSpec = input.kagentSpec || input.kagent || null;
  const result = wfModel.normalizeKagentSpec(rawSpec || {});
  const errors = [...result.errors];
  const spec = result.spec;
  const nodeShaped = {
    systemPrompt: input.systemPrompt || '',
    kagentSpec: spec,
  };
  const composed = wfModel.composeKagentSystemPrompt(nodeShaped);
  if (!composed) errors.push('Agent needs a system prompt (base or from promptAppend bindings).');
  const name = input.crdName ? dnsLabel(input.crdName) : id;
  const ns = namespace || (kagentConfig() || { namespace: 'kagent' }).namespace;

  const inline = { modelConfig: spec.modelConfig || { name: 'default-model-config' } };
  // The designer's Model dropdown names a preset id from the global catalog;
  // it overrides the ModelConfig default on the agent template.
  if (input.model) inline.model = String(input.model).slice(0, 128);
  const cr = {
    apiVersion: 'api.kagent.dev/v1alpha3',
    kind: 'Agent',
    metadata: {
      name,
      namespace: ns,
      labels: {
        'app.kubernetes.io/managed-by': 'agentix-workflows',
        'fleet.agent/category': dnsLabel(input.category || 'custom', 'custom'),
      },
    },
    spec: {
      harnessRef: { name: dnsLabel(input.harnessRef || input.harness || 'my-first-harness') },
      template: { inline },
    },
  };
  const out = { ok: errors.length === 0, name, namespace: ns, agent: cr, warnings: wfModel.kagentSpecWarnings(result) };
  if (errors.length) { out.errors = errors; return out; }

  if (composed.length > SYSTEM_PROMPT_INLINE_MAX) {
    const cmName = dnsLabel(`${name}-prompts`);
    out.configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: cmName, namespace: ns, labels: cr.metadata.labels },
      data: { SYSTEM: composed },
    };
    inline.systemPromptFrom = { key: 'SYSTEM', name: cmName };
  } else {
    inline.systemPrompt = composed;
  }
  if (spec.skills.length) inline.skills = spec.skills.map((skill) => ({ name: skill.name, source: skill.source }));
  if (spec.plugins.length) inline.plugins = spec.plugins.map((plugin) => ({ source: plugin.source, ...(plugin.skills.length ? { skills: plugin.skills } : {}) }));
  if (spec.tools.length) {
    inline.tools = spec.tools.map((tool) => (tool.kind === 'mcp'
      ? { mcp: { server: { kind: 'RemoteMCPServer', name: tool.server }, ...(tool.tools.length ? { tools: tool.tools } : {}), ...(tool.requireApproval ? { requireApproval: true } : {}) } }
      : { subAgent: { name: tool.name, description: tool.description, templateRef: { name: tool.templateRef } } }));
  }
  const policyRefs = (Array.isArray(input.egressPolicyRefs) && input.egressPolicyRefs.length ? input.egressPolicyRefs : spec.egressPolicyRefs) || [];
  if (policyRefs.length) {
    cr.spec.egressPolicyRefs = policyRefs.map((policyName) => ({ name: dnsLabel(policyName) }));
  }
  const env = spec.env.filter((row) => row && row.name);
  if (env.length) {
    out.harnessEnv = env;
    out.harnessWarning = `Harness "${cr.spec.harnessRef.name}" is shared: env rows are reported for the operator to merge into spec.env, not applied implicitly.`;
  }
  return out;
}

// --------------------------------------------------------------------- client

function createKagentClient(config = CONFIG.KAGENT, requestImpl = null) {
  const cfg = config === null ? null : kagentConfig(config);
  const request = requestImpl || (cfg ? (method, path, body) => defaultRequest(cfg, method, path, body) : null);

  function enabled() {
    return Boolean(cfg && request);
  }

  function collectionPath(kind, name) {
    const ns = cfg.namespace;
    let base;
    if (kind === 'configMap') base = `/api/v1/namespaces/${ns}/configmaps`;
    else {
      const plural = PLURALS[kind];
      if (!plural) throw new Error(`Unknown kagent kind ${kind}`);
      base = `/apis/${cfg.group}/${cfg.version}/namespaces/${ns}/${plural}`;
    }
    return name ? `${base}/${encodeURIComponent(name)}` : base;
  }

  async function list(kind) {
    const res = await request('GET', collectionPath(kind));
    if (res.status !== 200) throw new Error(`kagent list ${kind} failed: ${res.status} ${String(res.text || '').slice(0, 200)}`);
    return (res.body && res.body.items) || [];
  }

  async function get(kind, name) {
    const res = await request('GET', collectionPath(kind, name));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`kagent get ${kind}/${name} failed: ${res.status}`);
    return res.body;
  }

  /**
   * Apply = create when absent, replace when present.
   *
   * The replace must carry the stored object's `resourceVersion`: a PUT without
   * one is rejected `422 metadata.resourceVersion: Invalid value: 0: must be
   * specified for an update`, so a second publish of the same node would fail
   * every time while a first publish looked fine (404 → POST). The rendered CR
   * cannot know the version, so the live copy is read first. A 409 means it
   * moved between the read and the write — re-read and retry once rather than
   * clobbering whoever won.
   */
  async function apply(object) {
    const kindLower = String(object.kind) === 'ConfigMap'
      ? 'configMap'
      : Object.keys(PLURALS).find((key) => String(object.kind).toLowerCase() === key.toLowerCase());
    if (!kindLower) throw new Error(`Cannot apply ${object.kind} from this adapter`);
    const name = object.metadata.name;
    const collection = collectionPath(kindLower);
    const named = collectionPath(kindLower, name);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const live = await get(kindLower, name);
      if (!live) {
        const post = await request('POST', collection, object);
        if (post.status === 201 || post.status === 200) return { ok: true, created: true, body: post.body };
        if (post.status === 409) continue; // created while we were asking: replace it
        throw new Error(`kagent create ${object.kind}/${name} failed: ${post.status} ${String(post.text || '').slice(0, 300)}`);
      }
      const put = await request('PUT', named, {
        ...object,
        metadata: { ...object.metadata, resourceVersion: live.metadata.resourceVersion },
      });
      if (put.status === 200 || put.status === 201) return { ok: true, created: false, body: put.body };
      if (put.status === 404 || put.status === 409) continue; // deleted or edited under us
      throw new Error(`kagent apply ${object.kind}/${name} failed: ${put.status} ${String(put.text || '').slice(0, 300)}`);
    }
    throw new Error(`kagent apply ${object.kind}/${name} failed: the stored object changed on every attempt.`);
  }

  async function remove(kind, name) {
    const res = await request('DELETE', collectionPath(kind, name));
    if (res.status === 200 || res.status === 204) return { ok: true };
    if (res.status === 404) return { ok: false, missing: true };
    throw new Error(`kagent delete ${kind}/${name} failed: ${res.status}`);
  }

  async function capabilities() {
    const [harnesses, modelConfigs, remoteMcpServers, agentTemplates] = await Promise.all([
      list('harness'), list('modelConfig'), list('remoteMcpServer'), list('agentTemplate'),
    ]);
    return {
      namespace: cfg.namespace,
      harnesses: harnesses.map((item) => item.metadata.name),
      modelConfigs: modelConfigs.map((item) => item.metadata.name),
      remoteMcpServers: remoteMcpServers.map((item) => item.metadata.name),
      agentTemplates: agentTemplates.map((item) => item.metadata.name),
    };
  }

  /** Publish one designed agent profile: validate, render, apply. */
  async function publishProfile(profile) {
    if (!enabled()) return { ok: false, error: 'kagent_not_configured' };
    const rendered = renderAgentCrd(profile, { namespace: cfg.namespace });
    if (!rendered.ok) return { ok: false, error: 'kagent_spec_invalid', errors: rendered.errors };
    if (rendered.configMap) await apply(rendered.configMap);
    const outcome = await apply(rendered.agent);
    return {
      ok: true,
      name: rendered.name,
      namespace: rendered.namespace,
      created: outcome.created,
      warnings: rendered.warnings,
      harnessEnv: rendered.harnessEnv || [],
      harnessWarning: rendered.harnessWarning || null,
    };
  }

  /**
   * Un-publishing must remove both CRs the publish path may have written. A
   * prompt that crossed the inline limit lives in `<name>-prompts`, and deleting
   * only the Agent strands that ConfigMap in the namespace with nothing left to
   * own it — re-publishing then reuses it with stale text if the new prompt is
   * short enough to go inline.
   */
  async function unpublishProfile(id) {
    if (!enabled()) return { ok: false, error: 'kagent_not_configured' };
    const name = dnsLabel(id);
    const outcome = await remove('agent', name);
    await remove('configMap', dnsLabel(`${name}-prompts`));
    return outcome;
  }

  async function status() {
    if (!enabled()) return { enabled: false, reason: 'kagent_not_configured' };
    try {
      const items = await list('agent');
      return { enabled: true, namespace: cfg.namespace, agents: items.length };
    } catch (error) {
      return { enabled: true, namespace: cfg.namespace, reachable: false, error: String(error.message || error).slice(0, 300) };
    }
  }

  return { enabled, list, get, apply, remove, capabilities, publishProfile, unpublishProfile, status, render: renderAgentCrd };
}

const shared = createKagentClient();

module.exports = {
  createKagentClient,
  renderAgentCrd,
  kagentConfig,
  dnsLabel,
  PLURALS,
  enabled: () => shared.enabled(),
  capabilities: () => shared.capabilities(),
  publishProfile: (profile) => shared.publishProfile(profile),
  unpublishProfile: (id) => shared.unpublishProfile(id),
  status: () => shared.status(),
};
