'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgent } = require('./deepagent');

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
