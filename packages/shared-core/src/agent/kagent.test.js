'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKagentClient, renderAgentCrd, kagentConfig, dnsLabel, PLURALS } = require('./kagent.js');

const PIN = (hex) => `ghcr.io/acme/skills@sha256:${hex.repeat(64)}`;

function fakeConfig(overrides = {}) {
  return {
    enabled: true,
    apiUrl: 'https://k8s.example.internal:6443',
    namespace: 'kagent',
    tokenFile: '',
    caFile: '',
    kubeconfig: '/tmp/kubeconfig',
    group: 'api.kagent.dev',
    version: 'v1alpha3',
    timeoutMs: 15000,
    ...overrides,
  };
}

/** Client wired to a scripted request impl; records every call. */
function stubClient(responder, overrides = {}) {
  const calls = [];
  const cfg = fakeConfig(overrides);
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    return responder(method, url, body, calls.length - 1);
  };
  return { client: createKagentClient(cfg, request), calls, cfg };
}

const ok = (body) => async () => ({ status: 200, body, text: JSON.stringify(body) });

// ------------------------------------------------------------------- name slugs

test('dnsLabel produces Kubernetes-safe names and never an empty label', () => {
  assert.equal(dnsLabel('Builder / Coding Agent'), 'builder-coding-agent');
  assert.equal(dnsLabel('---'), 'agent');
  assert.equal(dnsLabel(''), 'agent');
  // Non-ASCII folds to a separator; whatever survives must still be a valid label.
  assert.match(dnsLabel('Ünicode ✗ name'), /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  assert.equal(dnsLabel('日本語'), 'agent');
  assert.ok(dnsLabel('x'.repeat(200)).length <= 63);
});

// ---------------------------------------------------------------------- config

test('kagentConfig is inert unless enabled with an API server', () => {
  assert.equal(kagentConfig(fakeConfig({ enabled: false })), null);
  assert.equal(kagentConfig(fakeConfig({ apiUrl: '', kubeconfig: '' })), null);
});

test('kagentConfig accepts a token file or a kubeconfig, and fails closed on unreadable auth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kagent-test-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'sa-token\n');
  const withToken = kagentConfig(fakeConfig({ tokenFile, kubeconfig: '' }));
  assert.equal(withToken.token, 'sa-token', 'token is trimmed');
  assert.equal(withToken.namespace, 'kagent');

  const missing = kagentConfig(fakeConfig({ tokenFile: path.join(dir, 'nope'), kubeconfig: '' }));
  assert.equal(missing, null, 'enabled but unauthenticated must not produce a client');
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------------- rendering

const FULL_PROFILE = {
  id: 'builder-coding',
  name: 'Coding Agent',
  category: 'Coding',
  harness: 'claude-code',
  systemPrompt: 'You are the coding agent.',
  egressPolicyRefs: ['allow-openrouter'],
  kagentSpec: {
    modelConfig: { name: 'openrouter-model-config', namespace: 'kagent' },
    skills: [{ name: 'code-review', source: { oci: PIN('a') }, promptAppend: 'Review for injection.' }],
    plugins: [{ source: { oci: PIN('b') }, skills: ['ship-it'], promptAppend: 'Follow release policy.' }],
    tools: [
      { kind: 'mcp', server: 'kagent-tool-server', tools: ['search'], requireApproval: true, promptAppend: 'Cite every source.' },
      { kind: 'subAgent', name: 'planner', templateRef: 'agent-template-planner', description: 'Plans work' },
    ],
    env: [{ name: 'LOG_LEVEL', value: 'debug' }],
  },
};

/** Over-long compositions can only come from appends: the base prompt is
 * capped far below SYSTEM_PROMPT_INLINE_MAX, 16 x 4 000 is not. */
const LONG_COMPOSITION_PROFILE = {
  id: 'builder-coding',
  name: 'Coding Agent',
  systemPrompt: 'You are the coding agent.',
  kagentSpec: {
    skills: Array.from({ length: 16 }, (_, i) => ({
      name: `skill-${i}`,
      source: { oci: `ghcr.io/acme/s${i}@sha256:${String(i).padStart(64, '0')}` },
      promptAppend: 'x'.repeat(4000),
    })),
  },
};

test('renderAgentCrd emits a v1alpha3 Agent with an inline template', () => {
  const out = renderAgentCrd(FULL_PROFILE, { namespace: 'kagent' });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.agent.apiVersion, 'api.kagent.dev/v1alpha3');
  assert.equal(out.agent.kind, 'Agent');
  assert.equal(out.agent.metadata.name, 'builder-coding');
  assert.equal(out.agent.metadata.namespace, 'kagent');
  assert.equal(out.agent.metadata.labels['app.kubernetes.io/managed-by'], 'agentix-workflows');
  assert.equal(out.agent.spec.harnessRef.name, 'claude-code');
  assert.deepEqual(out.agent.spec.egressPolicyRefs, [{ name: 'allow-openrouter' }]);
  assert.deepEqual(out.agent.spec.template.inline.modelConfig, { name: 'openrouter-model-config', namespace: 'kagent' });
});

// A tenant profile routed through the self-hosted LiteLLM gateway: the wire model
// must stay the BARE id (LiteLLM matches model_name verbatim), the runtime is a
// published harness, and egress refs / harnessRef carry through.
const LITELLM_PROFILE = {
  id: 'acme-coding',
  name: 'Coding Agent',
  category: 'Coding',
  harness: 'claude-code',
  systemPrompt: 'You are the coding agent.',
  egressPolicyRefs: ['acme-deny-external'],
  kagentSpec: {
    modelConfig: { name: 'acme-litellm-claude' },
    skills: [],
    plugins: [],
    tools: [],
    env: [
      { name: 'LOG_LEVEL', value: 'info' },
      { name: 'AGENT_MODEL', value: 'claude-sonnet-4-5' },
    ],
  },
};

test('renderAgentCrd renders a LiteLLM-routed tenant agent with a bare model id', () => {
  const out = renderAgentCrd(LITELLM_PROFILE, { namespace: 'tenant-acme' });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.agent.apiVersion, 'api.kagent.dev/v1alpha3');
  assert.equal(out.agent.kind, 'Agent');
  assert.equal(out.agent.metadata.namespace, 'tenant-acme');
  assert.equal(out.agent.spec.harnessRef.name, 'claude-code');
  assert.deepEqual(out.agent.spec.egressPolicyRefs, [{ name: 'acme-deny-external' }]);
  assert.deepEqual(out.agent.spec.template.inline.modelConfig, { name: 'acme-litellm-claude' });
  // The AGENT_MODEL env row must carry the bare id (no provider/ prefix). renderAgentCrd
  // reports Harness env as harnessEnv — it never writes it into the shared Agent CR.
  const modelEnv = (out.harnessEnv || []).find((e) => e.name === 'AGENT_MODEL');
  assert.ok(modelEnv, 'AGENT_MODEL harness env is reported');
  assert.equal(modelEnv.value, 'claude-sonnet-4-5');
  assert.doesNotMatch(modelEnv.value, /\//, 'litellm wire model must be the bare id');
  assert.equal(JSON.stringify(out.agent).includes('AGENT_MODEL'), false, 'env must not be smuggled into the Agent CR');
  // No raw credential literal may reach the agent surface.
  assert.doesNotMatch(JSON.stringify(out.agent), /sk-ant-|lsv2_|ghp_/);
});

test('renderAgentCrd composes promptAppend into the system prompt, in declaration order', () => {
  const out = renderAgentCrd(FULL_PROFILE, { namespace: 'kagent' });
  const prompt = out.agent.spec.template.inline.systemPrompt;
  const order = [
    prompt.indexOf('You are the coding agent.'),
    prompt.indexOf('Review for injection.'),
    prompt.indexOf('Follow release policy.'),
    prompt.indexOf('Cite every source.'),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'base, skills, plugins, then MCP appends');
  assert.ok(order.every((index) => index >= 0), 'every append must survive composition');
});

test('renderAgentCrd maps skills/plugins/tools onto the CRD shapes without leaking promptAppend', () => {
  const inline = renderAgentCrd(FULL_PROFILE, { namespace: 'kagent' }).agent.spec.template.inline;
  assert.deepEqual(inline.skills, [{ name: 'code-review', source: { oci: PIN('a') } }]);
  assert.deepEqual(inline.plugins, [{ source: { oci: PIN('b') }, skills: ['ship-it'] }]);
  assert.deepEqual(inline.tools, [
    { mcp: { server: { kind: 'RemoteMCPServer', name: 'kagent-tool-server' }, tools: ['search'], requireApproval: true } },
    { subAgent: { name: 'planner', description: 'Plans work', templateRef: { name: 'agent-template-planner' } } },
  ]);
  assert.equal(JSON.stringify(inline).includes('promptAppend'), false);
});

test('renderAgentCrd uses systemPromptFrom + ConfigMap only for an over-long prompt', () => {
  // The base prompt is capped well below the inline limit, so the only way to
  // cross it is a long composed prompt: base + every binding's promptAppend.
  const out = renderAgentCrd(LONG_COMPOSITION_PROFILE, { namespace: 'kagent' });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.agent.spec.template.inline.systemPrompt, undefined);
  assert.deepEqual(out.agent.spec.template.inline.systemPromptFrom, { key: 'SYSTEM', name: 'builder-coding-prompts' });
  assert.equal(out.configMap.metadata.name, 'builder-coding-prompts');
  assert.ok(out.configMap.data.SYSTEM.length > 60000);

  const small = renderAgentCrd(FULL_PROFILE, { namespace: 'kagent' });
  assert.equal(small.configMap, undefined, 'short prompts stay inline — systemPrompt xor systemPromptFrom');
});

test('renderAgentCrd reports Harness env instead of writing it into the shared Harness', () => {
  const out = renderAgentCrd(FULL_PROFILE, { namespace: 'kagent' });
  assert.deepEqual(out.harnessEnv, [{ name: 'LOG_LEVEL', value: 'debug' }]);
  assert.match(out.harnessWarning, /shared/);
  assert.equal(JSON.stringify(out.agent).includes('LOG_LEVEL'), false, 'env must not be smuggled into the Agent CR');
});

test('a node publish names the Agent by its graph and node, not by the bare node id', () => {
  const node = { id: 'n1', refId: 'coding', systemPrompt: 'base', kagentSpec: {} };
  const sales = renderAgentCrd({ ...node, crdName: 'sales-onboarding-n1' }, { namespace: 'kagent' });
  const support = renderAgentCrd({ ...node, crdName: 'support-triage-n1' }, { namespace: 'kagent' });
  assert.equal(sales.name, 'sales-onboarding-n1');
  assert.equal(sales.agent.metadata.name, 'sales-onboarding-n1', 'the metadata name is what the cluster keys on');
  assert.notEqual(sales.name, support.name, 'two graphs whose agent node is called n1 must not overwrite each other');
  assert.equal(renderAgentCrd({ ...node, crdName: 'Sales Onboarding/n1' }, { namespace: 'kagent' }).name, 'sales-onboarding-n1');
  assert.equal(renderAgentCrd(node, { namespace: 'kagent' }).name, 'n1', 'with no graph qualifier the id the caller passed is still the name');
});

test('renderAgentCrd rejects a profile with no prompt to compose', () => {
  const out = renderAgentCrd({ id: 'bare', systemPrompt: '', kagentSpec: {} }, { namespace: 'kagent' });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /system prompt/);
});

test('renderAgentCrd drops credential-shaped env rows and unpinned sources', () => {
  const out = renderAgentCrd({
    id: 'leaky',
    systemPrompt: 'base',
    kagentSpec: {
      env: [{ name: 'OPENAI_API_KEY', value: `sk-${'a'.repeat(30)}` }],
      skills: [{ name: 'loose', source: { oci: 'ghcr.io/acme/skills:latest' } }],
    },
  }, { namespace: 'kagent' });
  assert.deepEqual(out.harnessEnv, undefined, 'secret-valued env row must not be rendered');
  assert.deepEqual(out.agent.spec.template.inline.skills, undefined, 'unpinned OCI source must be rejected');
});

test('renderAgentCrd warns about git/bucket sources that never become Ready on the actor', () => {
  const out = renderAgentCrd({
    id: 'git-skill',
    systemPrompt: 'base',
    kagentSpec: { skills: [{ name: 'from-git', source: { git: { url: 'https://github.com/acme/skills', commit: 'b'.repeat(40) } } }] },
  }, { namespace: 'kagent' });
  assert.equal(out.ok, true);
  assert.match(out.warnings.join(' '), /git\/bucket source/i);
  assert.match(out.warnings.join(' '), /do not become Ready/i);
});

// ----------------------------------------------------------------------- client

test('client reports kagent_not_configured when disabled, for every verb', async () => {
  const client = createKagentClient(fakeConfig({ enabled: false }), () => {
    throw new Error('disabled client must not issue a request');
  });
  assert.equal(client.enabled(), false);
  assert.deepEqual(await client.publishProfile(FULL_PROFILE), { ok: false, error: 'kagent_not_configured' });
  assert.deepEqual(await client.unpublishProfile('x'), { ok: false, error: 'kagent_not_configured' });
  assert.deepEqual(await client.status(), { enabled: false, reason: 'kagent_not_configured' });
});

test('unpublishProfile deletes the prompt ConfigMap along with the Agent', async () => {
  const { client, calls } = stubClient(async (method) => (method === 'DELETE'
    ? { status: 200, body: {}, text: '' }
    : { status: 404, body: null, text: '' }));
  const out = await client.unpublishProfile('builder coding');
  assert.equal(out.ok, true);
  assert.deepEqual(calls.map((call) => call.method), ['DELETE', 'DELETE']);
  assert.deepEqual(calls.map((call) => call.url), [
    '/apis/api.kagent.dev/v1alpha3/namespaces/kagent/agents/builder-coding',
    '/api/v1/namespaces/kagent/configmaps/builder-coding-prompts',
  ]);
});

test('publishProfile applies the ConfigMap before the Agent it references', async () => {
  const absent = async (method) => (method === 'GET' ? { status: 404, body: null, text: '' } : { status: 201, body: {}, text: '' });
  const { client, calls } = stubClient(absent);
  const out = await client.publishProfile(LONG_COMPOSITION_PROFILE);
  assert.equal(out.ok, true);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /^\/api\/v1\/namespaces\/kagent\/configmaps\/builder-coding-prompts$/);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST', 'GET', 'POST']);
  assert.match(calls[1].url, /^\/api\/v1\/namespaces\/kagent\/configmaps$/);
  assert.match(calls[2].url, /^\/apis\/api\.kagent\.dev\/v1alpha3\/namespaces\/kagent\/agents\/builder-coding$/);
  assert.match(calls[3].url, /^\/apis\/api\.kagent\.dev\/v1alpha3\/namespaces\/kagent\/agents$/);
});

test('publishProfile creates on a missing object and refuses to apply an invalid spec', async () => {
  const absent = async (method) => (method === 'GET' ? { status: 404, body: null, text: '' } : { status: 201, body: {}, text: '' });
  const { client, calls } = stubClient(absent);
  const out = await client.publishProfile(FULL_PROFILE);
  assert.deepEqual({ ok: out.ok, created: out.created, name: out.name }, { ok: true, created: true, name: 'builder-coding' });
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST']);

  const invalid = await client.publishProfile({ id: 'nope', systemPrompt: '' });
  assert.deepEqual({ ok: invalid.ok, error: invalid.error }, { ok: false, error: 'kagent_spec_invalid' });
  assert.equal(calls.length, 2, 'an invalid spec must not reach the API server');
});

test('a re-publish sends the stored resourceVersion, without which a replace is a 422', async () => {
  const { client, calls } = stubClient(async (method) => (method === 'GET'
    ? { status: 200, body: { metadata: { name: 'builder-coding', resourceVersion: '4172' } }, text: '' }
    : { status: 200, body: {}, text: '' }));
  const out = await client.publishProfile(FULL_PROFILE);
  assert.equal(out.created, false);
  const put = calls.find((call) => call.method === 'PUT');
  assert.ok(put, 'an existing object must be replaced, not created again');
  assert.equal(put.body.metadata.resourceVersion, '4172');
});

test('a conflict re-reads the newer copy instead of forcing the same write through', async () => {
  let reads = 0;
  const { client, calls } = stubClient(async (method) => {
    if (method === 'GET') {
      reads += 1;
      return { status: 200, body: { metadata: { resourceVersion: reads === 1 ? '1' : '2' } }, text: '' };
    }
    const alreadyPut = calls.filter((call) => call.method === 'PUT').length;
    return alreadyPut === 1 ? { status: 409, body: null, text: 'conflict' } : { status: 200, body: {}, text: '' };
  });
  const out = await client.publishProfile(FULL_PROFILE);
  assert.equal(out.ok, true);
  assert.deepEqual(calls.filter((call) => call.method === 'PUT').map((call) => call.body.metadata.resourceVersion), ['1', '2']);
});

test('apply gives up rather than looping when the object keeps moving', async () => {
  const { client } = stubClient(async (method) => (method === 'PUT'
    ? { status: 409, body: null, text: 'conflict' }
    : { status: 200, body: { metadata: { resourceVersion: '7' } }, text: '' }));
  await assert.rejects(() => client.publishProfile(FULL_PROFILE), /changed on every attempt/);
});

test('capabilities lists live cluster objects for the palette', async () => {
  const names = { harnesses: ['claude-code', 'codex'], modelconfigs: ['default-model-config'], remotemcpservers: ['kagent-tool-server'], agenttemplates: ['tpl-a'] };
  const { client } = stubClient(async (method, url) => {
    const plural = url.split('/').pop();
    return { status: 200, body: { items: (names[plural] || []).map((name) => ({ metadata: { name } })) }, text: '' };
  });
  assert.deepEqual(await client.capabilities(), {
    namespace: 'kagent',
    harnesses: ['claude-code', 'codex'],
    modelConfigs: ['default-model-config'],
    remoteMcpServers: ['kagent-tool-server'],
    agentTemplates: ['tpl-a'],
  });
});

test('get returns null on 404 and list throws with the server message on anything else', async () => {
  const missing = stubClient(async () => ({ status: 404, body: null, text: 'agents.api.kagent.dev "x" not found' }));
  assert.equal(await missing.client.get('agent', 'x'), null);

  const refused = stubClient(async () => ({ status: 403, body: null, text: 'cannot list resources' }));
  await assert.rejects(() => refused.client.list('agent'), /403.*cannot list resources/);
});

test('remove distinguishes deleted from already-missing', async () => {
  const gone = stubClient(async () => ({ status: 404, body: null, text: '' }));
  assert.deepEqual(await gone.client.remove('agent', 'x'), { ok: false, missing: true });
  const deleted = stubClient(async () => ({ status: 200, body: {}, text: '' }));
  assert.deepEqual(await deleted.client.remove('agent', 'x'), { ok: true });
});

test('status surfaces an unreachable API server without throwing', async () => {
  const { client } = stubClient(async () => {
    throw new Error('connect ETIMEDOUT');
  });
  const out = await client.status();
  assert.equal(out.enabled, true);
  assert.equal(out.reachable, false);
  assert.match(out.error, /ETIMEDOUT/);
});

test('unknown kinds and cluster-scoped CRs are refused before touching the API server', async () => {
  const { client, calls } = stubClient(ok({ items: [] }));
  await assert.rejects(() => client.apply({ kind: 'Secret', metadata: { name: 's' } }), /Cannot apply Secret/);
  await assert.rejects(() => client.apply({ kind: 'ClusterRole', metadata: { name: 'c' } }), /Cannot apply ClusterRole/);
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.values(PLURALS).sort(), ['agents', 'agenttemplates', 'egresspolicies', 'harnesses', 'modelconfigs', 'remotemcpservers']);
});

test('the rendered CR never carries a bearer token, kubeconfig path or secret value', () => {
  const out = renderAgentCrd(FULL_PROFILE, { namespace: 'kagent' });
  const serialized = JSON.stringify({ agent: out.agent, configMap: out.configMap });
  for (const needle of ['authorization', 'Bearer', 'token', 'kubeconfig', 'ca.crt', 'service-account']) {
    assert.equal(serialized.toLowerCase().includes(needle.toLowerCase()), false, `CR must not mention ${needle}`);
  }
});
