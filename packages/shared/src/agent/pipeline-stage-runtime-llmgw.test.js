'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreflightSnapshot,
  createStageCommandV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const { resolveStageAgent } = require('./pipeline-stage-runtime');

const NOW = '2026-08-15T10:00:00.000Z';

function command({ request = {} } = {}) {
  const preflight = createPreflightSnapshot({
    runId: 'llmgw-run',
    organizationId: 'org-1',
    projectId: 'native-project-1',
    requestedStages: ['code'],
    repository: { provider: 'github', fullName: 'acme/fleet' },
    workItem: {},
    stageConfiguration: {
      code: {
        harness: 'deepagent', provider: 'ollama', model: 'qwen2.5-coder:7b',
        modelId: 'ollama-qwen2.5-coder-7b', providerReady: true, brokered: true,
      },
    },
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
    input: { request, priorResults: [] },
  }, { clock: () => NOW });
}

function dependencies(seen) {
  return {
    settings: { linearApiKey: 'linear-key' },
    resolveLlm: async (settings) => {
      seen.push(settings);
      return { provider: 'ollama', model: 'qwen2.5-coder:7b', host: 'http://ollama' };
    },
  };
}

test('durable stage resolve merges the admitted llm-gateway flag into settings', async () => {
  const seen = [];
  const agent = await resolveStageAgent(
    command({ request: { llmGateway: 'langsmith' } }),
    { role: 'execution', workflowStage: 'coding' },
    dependencies(seen),
  );
  assert.equal(seen[0].llmGateway, 'langsmith');
  assert.equal(seen[0].linearApiKey, 'linear-key');
  // The flag changes routing only — the admitted model snapshot still matches.
  assert.equal(agent.llm.model, 'qwen2.5-coder:7b');
});

test('durable stage resolve leaves settings untouched without the flag', async () => {
  const seen = [];
  await resolveStageAgent(
    command(),
    { role: 'execution', workflowStage: 'coding' },
    dependencies(seen),
  );
  assert.deepEqual(seen[0], { linearApiKey: 'linear-key' });
});

test('durable stage resolve ignores unknown llm-gateway selectors', async () => {
  const seen = [];
  await resolveStageAgent(
    command({ request: { llmGateway: 'other-router' } }),
    { role: 'execution', workflowStage: 'coding' },
    dependencies(seen),
  );
  assert.deepEqual(seen[0], { linearApiKey: 'linear-key' });
});
