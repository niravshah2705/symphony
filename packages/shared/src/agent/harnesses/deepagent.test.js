'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildAgent,
  buildBackend,
  quoteShellArg,
  requiresNetworkIsolation,
} = require('./deepagent');

test('coding shell isolation is mandatory in production and proxy-backed runtimes', () => {
  assert.equal(requiresNetworkIsolation({ NODE_ENV: 'production' }), true);
  assert.equal(requiresNetworkIsolation({ NODE_ENV: 'development', EGRESS_PROXY_URL: 'http://127.0.0.1:4030' }), true);
  assert.equal(requiresNetworkIsolation({ NODE_ENV: 'test' }), false);
  assert.equal(requiresNetworkIsolation({ NODE_ENV: 'test' }, true), true);
});

test('DeepAgent wraps model shell text as one opaque argument below the sandbox', async () => {
  class RecordingShellBackend {
    constructor(options) { this.options = options; }
    async execute(command) { this.command = command; return { output: '', exitCode: 0 }; }
  }
  const backend = buildBackend('shell', '/tmp/deepagent-network-test', {
    env: { PATH: '/usr/bin:/bin' },
    networkSandboxCommand: '/test/network-sandbox',
  }, {
    runtimeEnv: { EGRESS_PROXY_URL: 'http://127.0.0.1:4030' },
    deepagents: { LocalShellBackend: RecordingShellBackend, FilesystemBackend: class {} },
  });
  const modelCommand = "printf '%s' \"$(id)\"; echo `whoami`;\nprintf done";

  await backend.execute(modelCommand);

  assert.equal(
    backend.command,
    `exec '/test/network-sandbox' '/bin/sh' '-lc' ${quoteShellArg(modelCommand)}`,
  );
  assert.equal(backend.options.inheritEnv, false);
});

test('shell quoting cannot execute substitutions outside the sandbox launcher', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepagent-network-quote-'));
  const escapedMarker = path.join(root, 'escaped');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = buildBackend('shell', root, {
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    // `false` stands in for a launcher that refuses to execute its argv. If the
    // model string escapes the outer quote, its command substitution writes the
    // marker before `exec`; correctly opaque argv never creates it.
    networkSandboxCommand: '/usr/bin/false',
  }, {
    runtimeEnv: { NODE_ENV: 'production' },
    deepagents: require('deepagents'),
  });

  const result = await backend.execute(`'$(printf escaped > ${quoteShellArg(escapedMarker)})'`);

  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.existsSync(escapedMarker), false);
});

test('a missing sandbox launcher fails closed without running the model command', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepagent-network-missing-'));
  const marker = path.join(root, 'must-not-run');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = buildBackend('shell', root, {
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    networkSandboxCommand: path.join(root, 'missing-network-sandbox'),
  }, {
    runtimeEnv: { EGRESS_PROXY_URL: 'http://127.0.0.1:4030' },
    deepagents: require('deepagents'),
  });

  const result = await backend.execute(`printf unsafe > ${quoteShellArg(marker)}`);

  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.existsSync(marker), false);
});

test('direct nonproduction shell commands preserve existing local behavior', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepagent-network-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = buildBackend('shell', root, {
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  }, {
    runtimeEnv: { NODE_ENV: 'development' },
    deepagents: require('deepagents'),
  });

  const result = await backend.execute('printf local-ok');

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'local-ok');
});

test('DeepAgent receives immutable workflow permissions for filesystem-only stages', () => {
  const permissions = [{ operations: ['write'], paths: ['/**'], mode: 'deny' }];
  let captured;
  buildAgent({
    workflow: {
      name: 'deployment',
      backend: 'filesystem',
      tools: [],
      skills: [],
      permissions,
      systemPrompt: 'Use only the brokered deployment tool.',
    },
    llm: { provider: 'ollama', model: 'fixture' },
    backend: {},
    skillPaths: [],
    ctx: {
      effectivePolicy: {
        harness: { effective: ['deepagent'] },
        tools: { effective: [] },
        skills: { effective: [] },
        plugins: { effective: [] },
        hooks: { effective: [] },
        models: { effective: [] },
      },
    },
  }, {
    createChatModel: () => ({ model: 'fixture' }),
    deepagents: {
      createDeepAgent: (options) => {
        captured = options;
        return { invoke: async () => ({ messages: [] }) };
      },
    },
  });

  assert.deepEqual(captured.permissions, permissions);
});
