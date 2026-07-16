'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { repositoryAllowsMcp } = require('./mcp');
const codingWorkflow = require('./workflows/coding.workflow');

test('GitHub MCP is disabled for GitLab and all repository-broker runs', () => {
  assert.equal(repositoryAllowsMcp('github', { repositoryProvider: 'gitlab' }), false);
  assert.equal(repositoryAllowsMcp('github', { repositoryProvider: 'github', repositoryBroker: true }), false);
  assert.equal(repositoryAllowsMcp('github', { repositoryProvider: 'github', repositoryBroker: false }), true);
  assert.equal(repositoryAllowsMcp('linear', { repositoryProvider: 'gitlab', repositoryBroker: true }), true);
});

test('coding workflow exposes no broad provider-specific forge MCP', () => {
  assert.deepEqual(codingWorkflow.mcp, ['linear']);
  assert.match(codingWorkflow.buildWorkflowPrompt({ prLabel: 'agent' }), /repository_broker/);
});
