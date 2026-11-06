'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreflightSnapshot,
  createStageCommandV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const { resolveStageAgent } = require('./pipeline-stage-runtime');

const NOW = '2026-08-15T10:00:00.000Z';

// The preflight decision that says which key pays used to stop at admission. These
// tests are the seam that hands it to metering: an org running on its own credential
// must be reported as such by the stage runtime, or the sweep debits money the
// platform never spent.
function command({ providerSource } = {}) {
  const stageConfig = {
    harness: 'deepagent', provider: 'ollama', model: 'qwen2.5-coder:7b',
    modelId: 'ollama-qwen2.5-coder-7b', providerReady: true, brokered: true,
  };
  if (providerSource !== undefined) stageConfig.providerSource = providerSource;
  const preflight = createPreflightSnapshot({
    runId: 'byok-run',
    organizationId: 'org-1',
    projectId: 'native-project-1',
    requestedStages: ['code'],
    repository: { provider: 'github', fullName: 'acme/fleet' },
    workItem: {},
    stageConfiguration: { code: stageConfig },
    policy: {
      effectivePolicy: {
        harness: { effective: ['deepagent'] }, tools: { effective: [] }, skills: { effective: [] },
        plugins: { effective: [] }, hooks: { effective: [] }, models: { effective: ['ollama-qwen2.5-coder-7b'] },
      },
      prefs: {},
    },
  }, { clock: () => NOW });
  return createStageCommandV1({
    runId: preflight.runId,
    organizationId: preflight.organizationId,
    projectId: preflight.projectId,
    requestedStages: ['code'],
    preflight,
    stage: 'code',
    attempt: 1,
    input: { request: {}, priorResults: [] },
  }, { clock: () => NOW });
}

function dependencies() {
  return {
    settings: { linearApiKey: 'linear-key' },
    resolveLlm: async () => ({ provider: 'ollama', model: 'qwen2.5-coder:7b', host: 'http://ollama' }),
  };
}

function resolve(snapshot) {
  return resolveStageAgent(snapshot, { role: 'execution', workflowStage: 'coding' }, dependencies());
}

test('a stage admitted on the organization key reports itself as customer', async () => {
  assert.equal((await resolve(command({ providerSource: 'customer' }))).providerSource, 'customer');
});

test('a stage admitted on a platform key reports no source at all', async () => {
  assert.equal((await resolve(command({ providerSource: 'managed' }))).providerSource, null);
});

// A snapshot taken before BYOK metering existed has no decision in it. It must read
// as a platform key, because a missing label that resolved to customer would make
// every historic run free.
test('a stage snapshot without the decision reports no source', async () => {
  assert.equal((await resolve(command())).providerSource, null);
});
