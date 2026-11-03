'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeSandboxName,
  normalizeSandboxName,
  resolveOpenShellWorkspace,
  encodeObjectMeta,
  decodeObjectMeta,
  buildDockerConfigJson,
  buildOrgImagePullSecretManifest,
  getGatewayStatus,
  syncNvidiaSecrets,
  ensureProjectSandbox,
  stopProjectSandbox,
  startProjectSandbox,
  deleteProjectSandbox,
  changeSandboxImage,
  listSandboxes,
  execInteractiveSandboxCommand,
  chatWithProjectSandbox,
  getSampleNetworkPolicy,
  runSandboxSecurityChecks,
} = require('../src/agent/openshell');

// Helper to build a protobuf wire response for tests
function encodeVarint(value) {
  const bytes = [];
  let v = BigInt(value);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeString(fieldNumber, str) {
  const buf = Buffer.from(String(str), 'utf8');
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

function encodeMessage(fieldNumber, payloadBuf) {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(payloadBuf.length), payloadBuf]);
}

function okFrame(frame = Buffer.alloc(0)) {
  return {
    status: 0,
    message: '',
    headers: {},
    trailers: {},
    frames: [frame],
    firstFrame: frame,
  };
}

function buildSandboxResponse({ name, id = 'uid-123', phase = 2 }) {
  const meta = Buffer.concat([
    encodeString(1, id),
    encodeString(2, name),
  ]);
  const template = encodeString(1, 'ubuntu:24.04');
  const spec = encodeMessage(6, template);
  const status = Buffer.concat([encodeTag(6, 0), encodeVarint(phase)]);
  const sandbox = Buffer.concat([
    encodeMessage(1, meta),
    encodeMessage(2, spec),
    encodeMessage(3, status),
  ]);
  return encodeMessage(1, sandbox);
}

test('sanitizeSandboxName enforces <= 19 chars and valid DNS label', () => {
  const name1 = sanitizeSandboxName('My Very Long Project Name With Spaces And Symbols!!!');
  assert.ok(name1.length <= 19, `Expected length <= 19, got ${name1.length} (${name1})`);
  assert.match(name1, /^sb-[a-z0-9-]+$/);
  assert.ok(!name1.endsWith('-'));

  const name2 = sanitizeSandboxName('');
  assert.equal(name2, 'sb-default');
});

test('getGatewayStatus decodes version and serving status', async () => {
  const mockTransport = async (method) => {
    if (method === 'Health') {
      return okFrame(Buffer.concat([encodeTag(1, 0), encodeVarint(1), encodeString(2, '0.1.5')]));
    }
    if (method === 'GetGatewayInfo') {
      return okFrame(encodeString(2, '0.1.5'));
    }
    return okFrame();
  };

  const status = await getGatewayStatus({
    url: 'https://openshell.archagentix.com',
    transport: mockTransport,
  });
  assert.equal(status.connected, true);
  assert.equal(status.status, 'SERVING');
  assert.equal(status.version, '0.1.5');
  assert.equal(status.url, 'https://openshell.archagentix.com');
});

test('syncNvidiaSecrets syncs github and openrouter secrets and handles operator namespace restriction gracefully', async () => {
  const calls = [];
  const mockTransport = async (method) => {
    calls.push(method);
    if (method === 'GetProvider' || method === 'GetProviderProfile') {
      return { status: 5, message: 'not found', frames: [], firstFrame: Buffer.alloc(0) };
    }
    if (method === 'CreateProvider') {
      return {
        status: 7,
        message: 'secret is not in the operator namespace allowlist',
        frames: [],
        firstFrame: Buffer.alloc(0),
      };
    }
    return okFrame();
  };

  const synced = await syncNvidiaSecrets({
    url: 'https://openshell.archagentix.com',
    githubToken: 'ghp_test123456',
    openrouterApiKey: 'sk-or-v1-test123456',
    transport: mockTransport,
  });

  assert.equal(synced.secrets.github.configured, true);
  assert.equal(synced.secrets.github.synced, true);
  assert.equal(synced.secrets.openrouter.configured, true);
  assert.equal(synced.secrets.openrouter.synced, true);
  assert.deepEqual(synced.providers, ['github', 'openrouter']);
  assert.ok(calls.includes('ImportProviderProfiles'));
  assert.ok(calls.includes('CreateProvider'));
});

test('ensureProjectSandbox creates or loads sandbox with GITHUB_TOKEN and OPENROUTER_API_KEY synced', async () => {
  const mockTransport = async (method) => {
    if (method === 'Health') {
      return okFrame(Buffer.concat([encodeTag(1, 0), encodeVarint(1), encodeString(2, '0.1.5')]));
    }
    if (method === 'GetSandbox' || method === 'GetProvider' || method === 'GetProviderProfile') {
      return { status: 5, message: 'not found', frames: [], firstFrame: Buffer.alloc(0) };
    }
    if (method === 'CreateSandbox') {
      return okFrame(buildSandboxResponse({ name: 'sb-alpha-proj', id: 'uid-alpha-999', phase: 2 }));
    }
    return okFrame();
  };

  const sandbox = await ensureProjectSandbox({
    url: 'https://openshell.archagentix.com',
    projectId: 'alpha-proj',
    projectName: 'Alpha Project',
    githubToken: 'ghp_test_token',
    openrouterApiKey: 'sk-or-test-key',
    transport: mockTransport,
  });

  assert.equal(sandbox.name, 'sb-alpha-proj');
  assert.equal(sandbox.phase, 'READY');
  assert.equal(sandbox.secrets.github.configured, true);
  assert.equal(sandbox.secrets.github.synced, true);
  assert.equal(sandbox.secrets.openrouter.configured, true);
  assert.equal(sandbox.secrets.openrouter.synced, true);
});

test('chatWithProjectSandbox executes inside the project sandbox and returns reply', async () => {
  const mockTransport = async (method) => {
    if (method === 'Health') {
      return okFrame(Buffer.concat([encodeTag(1, 0), encodeVarint(1), encodeString(2, '0.1.5')]));
    }
    if (method === 'GetSandbox') {
      return okFrame(buildSandboxResponse({ name: 'sb-chat-proj', id: 'uid-chat-111', phase: 2 }));
    }
    if (method === 'ExecSandbox') {
      const stdoutChunk = encodeMessage(
        1,
        encodeString(
          1,
          'HOSTNAME=sb-chat-proj\nKERNEL=Linux 6.8\nGITHUB_SECRET=present\nOPENROUTER_SECRET=present\n'
        )
      );
      return okFrame(stdoutChunk);
    }
    return okFrame();
  };

  const response = await chatWithProjectSandbox({
    url: 'https://openshell.archagentix.com',
    projectId: 'chat-proj',
    projectName: 'Chat Project',
    message: 'Check sandbox environment',
    githubToken: 'ghp_chat',
    openrouterApiKey: '',
    transport: mockTransport,
  });

  assert.equal(response.sandbox.name, 'sb-chat-proj');
  assert.match(response.reply, /NVIDIA OpenShell Sandbox `sb-chat-proj`/);
  assert.match(response.reply, /Check sandbox environment/);
});

test('resolveOpenShellWorkspace maps default to tenant-a and preserves allowed tenant workspaces', () => {
  assert.equal(resolveOpenShellWorkspace('default'), 'tenant-a');
  assert.equal(resolveOpenShellWorkspace(''), 'tenant-a');
  assert.equal(resolveOpenShellWorkspace('tenant-a'), 'tenant-a');
  assert.equal(resolveOpenShellWorkspace('tenant-b'), 'tenant-b');
});

test('encodeObjectMeta and decodeObjectMeta use datamodel.proto field numbers (labels=4, resourceVersion=5, workspace=7)', () => {
  const buf = encodeObjectMeta({
    name: 'sb-tenant-test',
    workspace: 'tenant-a',
    labels: { 'aifleet.io/org-id': 'org-123' },
  });
  const decoded = decodeObjectMeta(buf);
  assert.equal(decoded.name, 'sb-tenant-test');
  assert.equal(decoded.workspace, 'tenant-a');
  assert.equal(decoded.labels['aifleet.io/org-id'], 'org-123');
});

test('buildDockerConfigJson and buildOrgImagePullSecretManifest generate per-organization image registry secret', () => {
  const cfgStr = buildDockerConfigJson({
    registryUrl: 'ghcr.io',
    username: 'org-bot',
    password: 'ghp_secret_registry_token',
  });
  const parsed = JSON.parse(cfgStr);
  assert.ok(parsed.auths['ghcr.io']);
  assert.equal(parsed.auths['ghcr.io'].username, 'org-bot');

  const manifestYaml = buildOrgImagePullSecretManifest({
    workspace: 'tenant-a',
    organizationId: 'org-acme',
    registryUrl: 'ghcr.io',
    username: 'org-bot',
    password: 'ghp_secret_registry_token',
  });
  assert.match(manifestYaml, /kind: Secret/);
  assert.match(manifestYaml, /type: kubernetes\.io\/dockerconfigjson/);
  assert.match(manifestYaml, /namespace: tenant-a/);
  assert.match(manifestYaml, /aifleet\.nvidia\.com\/organization-id: "org-acme"/);
});

test('syncNvidiaSecrets syncs per-organization imageRegistry secret alongside github and openrouter', async () => {
  const synced = await syncNvidiaSecrets({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    organizationId: 'org-acme',
    githubToken: 'ghp_org1',
    openrouterApiKey: 'sk-or-v1-org1',
    imageRegistryUrl: 'ghcr.io',
    imageRegistryUsername: 'acme-user',
    imageRegistryPassword: 'acme-reg-password',
    transport: async () => okFrame(),
  });
  assert.equal(synced.workspace, 'tenant-a');
  assert.equal(synced.secrets.imageRegistry.configured, true);
  assert.equal(synced.secrets.imageRegistry.synced, true);
  assert.equal(synced.secrets.imageRegistry.registryUrl, 'ghcr.io');
  assert.ok(synced.providers.includes('image-registry'));
  assert.match(synced.secrets.imageRegistry.secretManifestYaml, /kind: Secret/);
});

test('getSampleNetworkPolicy and runSandboxSecurityChecks validate tenant isolation and security', async () => {
  const policy = getSampleNetworkPolicy({ workspace: 'tenant-a', organizationId: 'org-acme' });
  assert.equal(policy.name, 'openshell-tenant-sandbox-policy');
  assert.equal(policy.namespace, 'tenant-a');
  assert.match(policy.yaml, /169\.254\.169\.254\/32/);

  const mockTransport = async (method) => {
    if (method === 'Health') {
      return okFrame(Buffer.concat([encodeTag(1, 0), encodeVarint(1), encodeString(2, '0.1.5')]));
    }
    if (method === 'GetSandbox') {
      return okFrame(buildSandboxResponse({ name: 'sb-sec-proj', id: 'uid-sec-1', phase: 2 }));
    }
    if (method === 'ExecSandbox') {
      const stdoutChunk = encodeMessage(
        1,
        encodeString(
          1,
          'UID_CHECK=10001\nUSER_CHECK=sandbox\nWORKSPACE_WRITABLE=yes\nOPENCODE_BIN=/sandbox/.local/bin/opencode\nDOCKER_CONFIG=present\n'
        )
      );
      return okFrame(stdoutChunk);
    }
    return okFrame();
  };

  const sec = await runSandboxSecurityChecks({
    url: 'https://openshell.archagentix.com',
    projectId: 'sec-proj',
    workspace: 'tenant-a',
    transport: mockTransport,
  });
  assert.equal(sec.passed, true);
  assert.equal(sec.checks.length, 6);
  assert.ok(sec.checks.every((c) => c.passed));
});

test('changeSandboxImage and ensureProjectSandbox support changing container image from backend and UI', async () => {
  const rpcCalls = [];
  let currentImageInGateway = 'ubuntu:24.04';
  const mockTransport = async (method, payload) => {
    rpcCalls.push(method);
    if (method === 'Health') {
      return okFrame(Buffer.concat([encodeTag(1, 0), encodeVarint(1), encodeString(2, '0.1.5')]));
    }
    if (method === 'GetSandbox') {
      const meta = Buffer.concat([encodeString(1, 'uid-img-1'), encodeString(2, 'sb-img-test')]);
      const template = encodeString(1, currentImageInGateway);
      const spec = encodeMessage(6, template);
      const status = Buffer.concat([encodeTag(6, 0), encodeVarint(2)]);
      const sb = Buffer.concat([encodeMessage(1, meta), encodeMessage(2, spec), encodeMessage(3, status)]);
      return okFrame(encodeMessage(1, sb));
    }
    if (method === 'DeleteSandbox') {
      return okFrame();
    }
    if (method === 'CreateSandbox') {
      // Verify the new image string is encoded in CreateSandbox request
      assert.ok(payload.toString('utf8').includes('openeuler/opencode:latest'));
      currentImageInGateway = 'openeuler/opencode:latest';
      const meta = Buffer.concat([encodeString(1, 'uid-img-2'), encodeString(2, 'sb-img-test')]);
      const template = encodeString(1, currentImageInGateway);
      const spec = encodeMessage(6, template);
      const status = Buffer.concat([encodeTag(6, 0), encodeVarint(2)]);
      const sb = Buffer.concat([encodeMessage(1, meta), encodeMessage(2, spec), encodeMessage(3, status)]);
      return okFrame(encodeMessage(1, sb));
    }
    return okFrame();
  };

  const updated = await changeSandboxImage({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    organizationId: 'org-acme',
    projectId: 'img-test',
    sandboxName: 'sb-img-test',
    image: 'openeuler/opencode:latest',
    transport: mockTransport,
  });

  assert.equal(updated.name, 'sb-img-test');
  assert.equal(updated.image, 'openeuler/opencode:latest');
  assert.ok(rpcCalls.includes('DeleteSandbox'));
  assert.ok(rpcCalls.includes('CreateSandbox'));
});

test('multi-sandbox lifecycle: user can create, list, stop, start, and delete multiple sandboxes', async () => {
  const mockTransport = async (method) => {
    if (method === 'Health') {
      return okFrame(Buffer.concat([encodeTag(1, 0), encodeVarint(1), encodeString(2, '0.1.5')]));
    }
    if (method === 'GetSandbox') {
      return { status: 5, message: 'not found', frames: [], firstFrame: Buffer.alloc(0) };
    }
    if (method === 'CreateSandbox') {
      return okFrame(buildSandboxResponse({ name: 'sb-worker-two', id: 'uid-w2', phase: 2 }));
    }
    return okFrame();
  };

  const sb1 = await ensureProjectSandbox({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    organizationId: 'org-multi',
    projectId: 'multi-proj',
    sandboxName: 'sb-worker-one',
    image: 'ubuntu:24.04',
    transport: mockTransport,
  });

  const sb2 = await ensureProjectSandbox({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    organizationId: 'org-multi',
    projectId: 'multi-proj',
    sandboxName: 'sb-worker-two',
    image: 'openeuler/opencode:latest',
    transport: mockTransport,
  });

  assert.equal(sb1.name, 'sb-worker-one');
  assert.equal(sb2.name, 'sb-worker-two');
  assert.equal(sb2.image, 'openeuler/opencode:latest');

  const all = await listSandboxes({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    organizationId: 'org-multi',
    projectId: 'multi-proj',
    transport: mockTransport,
  });
  const names = all.map((s) => s.name);
  assert.ok(names.includes('sb-worker-one'));
  assert.ok(names.includes('sb-worker-two'));

  const stopped = await stopProjectSandbox({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    organizationId: 'org-multi',
    projectId: 'multi-proj',
    sandboxName: 'sb-worker-two',
    transport: mockTransport,
  });
  assert.equal(stopped.phase, 'STOPPED');

  const restarted = await startProjectSandbox({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    organizationId: 'org-multi',
    projectId: 'multi-proj',
    sandboxName: 'sb-worker-two',
    image: 'openeuler/opencode:latest',
    transport: mockTransport,
  });
  assert.equal(restarted.phase, 'READY');

  const deleted = await deleteProjectSandbox({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    organizationId: 'org-multi',
    projectId: 'multi-proj',
    sandboxName: 'sb-worker-two',
    transport: mockTransport,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.name, 'sb-worker-two');
});

test('execInteractiveSandboxCommand preserves working directory (cwd) across commands and strips internal state marker', async () => {
  const mockTransport = async (method, payload) => {
    if (method === 'ExecSandbox') {
      const reqStr = payload.toString('utf8');
      const markerMatch = reqStr.match(/__AIFLEET_STATE_[0-9a-f]+__/);
      const marker = markerMatch ? markerMatch[0] : '__AIFLEET_STATE_00000000__';
      const isCd = reqStr.includes('cd /workspace/subdir');
      const outText = isCd
        ? `\n${marker}:0:/workspace/subdir:sandbox:sb-inter-1\n`
        : `hello-interactive\n${marker}:0:/workspace/subdir:sandbox:sb-inter-1\n`;
      const stdoutChunk = encodeMessage(1, encodeString(1, outText));
      return okFrame(stdoutChunk);
    }
    return okFrame();
  };

  const step1 = await execInteractiveSandboxCommand({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    projectId: 'inter-proj',
    sandboxName: 'sb-inter-1',
    command: 'cd /workspace/subdir',
    cwd: '/workspace',
    transport: mockTransport,
  });
  assert.equal(step1.cwd, '/workspace/subdir');
  assert.equal(step1.user, 'sandbox');
  assert.equal(step1.stdout, '');

  const step2 = await execInteractiveSandboxCommand({
    url: 'https://openshell.archagentix.com',
    workspace: 'tenant-a',
    projectId: 'inter-proj',
    sandboxName: 'sb-inter-1',
    command: 'echo hello-interactive',
    transport: mockTransport,
  });
  assert.equal(step2.cwd, '/workspace/subdir');
  assert.equal(step2.stdout, 'hello-interactive');
  assert.ok(!step2.stdout.includes('__AIFLEET_STATE_'));
});
