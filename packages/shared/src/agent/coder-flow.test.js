'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  activeRepositoryArtifactReceipt,
  activeRepositoryBranch,
  assertOpenSweRepositoryProvider,
  executeCodingRuntime,
} = require('./coder');
const { pickStateByType } = require('../linear');
const framework = require('./framework');

test('OpenSWE fails closed for a GitLab repository selection', () => {
  assert.doesNotThrow(() => assertOpenSweRepositoryProvider('github'));
  assert.throws(() => assertOpenSweRepositoryProvider('gitlab'), /GitHub-only/);
});

test('coder results report the broker branch after an automatic retry rotation', () => {
  const broker = { publicInfo: () => ({ branch: 'task-123-retry-17' }) };
  assert.strictEqual(activeRepositoryBranch('task-123', broker), 'task-123-retry-17');
  assert.strictEqual(activeRepositoryBranch('task-123', null), 'task-123');
});

test('planned coder results export the broker-authoritative artifact receipt', () => {
  const receipt = {
    source: 'repository-broker',
    commandId: 'run-1:code:1',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
  };
  const broker = { artifactReceipt: () => receipt };

  assert.strictEqual(activeRepositoryArtifactReceipt(broker), receipt);
  assert.strictEqual(activeRepositoryArtifactReceipt(null), null);
});

test('proxied coding isolates DeepAgent shell and developer-tool contexts', async (t) => {
  const mcp = require('./mcp');
  const originalLoadMcpTools = mcp.loadMcpTools;
  const originalInstallSkills = framework.installSkills;
  const originalBuildAgent = framework.buildAgent;
  let mcpContext;
  let agentContext;
  mcp.loadMcpTools = async (_names, ctx) => {
    mcpContext = ctx;
    return [];
  };
  framework.installSkills = () => [];
  framework.buildAgent = (options) => {
    agentContext = options.ctx;
    return {
      agent: { invoke: async () => ({ messages: [{ role: 'assistant', content: 'done' }] }) },
      tools: [],
      skillPaths: [],
    };
  };
  t.after(() => {
    mcp.loadMcpTools = originalLoadMcpTools;
    framework.installSkills = originalInstallSkills;
    framework.buildAgent = originalBuildAgent;
  });

  const result = await executeCodingRuntime({
    llm: { provider: 'ollama', model: 'fixture', host: 'http://127.0.0.1:4030/ollama' },
    keys: { agentRuntime: 'deepagent', workflowPattern: 'sequential' },
    apiKey: 'sentinel',
    step: () => {},
    workDir: process.cwd(),
    env: {},
    repositoryProvider: 'github',
    repositoryBroker: null,
    prompt: 'test',
    invokeConfig: {},
    settings: {},
    attribution: {},
    runtimeEnv: { NODE_ENV: 'development', EGRESS_PROXY_URL: 'http://127.0.0.1:4030' },
  });

  assert.equal(mcpContext.isolateNetwork, true);
  assert.equal(agentContext.isolateNetwork, true);
  assert.equal(agentContext.cwd, process.cwd());
  assert.equal(result.finalText, 'done');
});

const STATES = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's-prog', name: 'In Progress', type: 'started', position: 2 },
  { id: 's-review', name: 'In Review', type: 'started', position: 3 },
  { id: 's-done', name: 'Done', type: 'completed', position: 4 },
];

test('pickStateByType prefers the state whose name matches', () => {
  assert.strictEqual(pickStateByType(STATES, 'started', 'In Progress').id, 's-prog');
});

test('pickStateByType falls back to the lowest-position state of the type', () => {
  // No "Working" name match → lowest-position started state (In Progress @2).
  assert.strictEqual(pickStateByType(STATES, 'started', 'Working').id, 's-prog');
});

test('pickStateByType resolves the completed (Done) state', () => {
  assert.strictEqual(pickStateByType(STATES, 'completed', 'Done').id, 's-done');
});

test('pickStateByType returns null when no state of the type exists', () => {
  assert.strictEqual(pickStateByType(STATES, 'canceled', 'Canceled'), null);
});
