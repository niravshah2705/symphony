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
  // Linear (tracker) and Playwright (local browser) are allowed; a broad forge
  // MCP (github) must never be attached — the repository broker owns forge ops.
  assert.ok(codingWorkflow.mcp.includes('linear'));
  assert.ok(!codingWorkflow.mcp.includes('github'));
  assert.match(codingWorkflow.buildWorkflowPrompt({ prLabel: 'agent' }), /repository_broker/);
});

test('coding workflow attaches the local Playwright MCP (opt-in) and not a forge MCP', () => {
  assert.ok(codingWorkflow.mcp.includes('playwright'));
});
