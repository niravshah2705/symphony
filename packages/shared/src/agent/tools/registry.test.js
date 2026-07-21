'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../tools');
const { TOOL_NAMES, TOOL_FACTORIES } = require('./index');
const codingWorkflow = require('../workflows/coding.workflow');

test('every developer tool is registered in the framework tool registry', () => {
  for (const name of TOOL_NAMES) {
    assert.ok(registry.FACTORIES[name], `registry is missing ${name}`);
  }
  // The built-in tools remain registered alongside the new folder.
  assert.ok(registry.FACTORIES.web_search);
  assert.ok(registry.FACTORIES.linear_graphql);
});

test('the coding workflow wires the full developer toolbox', () => {
  for (const name of TOOL_NAMES) {
    assert.ok(codingWorkflow.tools.includes(name), `coding workflow is missing ${name}`);
  }
  assert.ok(codingWorkflow.mcp.includes('playwright'));
});

test('buildMany builds known tools and silently drops unknown names', () => {
  const built = registry.buildMany([...TOOL_NAMES, 'no_such_tool'], { cwd: process.cwd(), step: () => {} });
  assert.equal(built.length, TOOL_NAMES.length);
  for (const t of built) {
    assert.ok(t.name && t.description, 'each built tool has a name and description');
  }
});

test('each developer-tool factory produces a tool whose name matches its registry key', () => {
  for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
    const tool = factory({ cwd: process.cwd(), step: () => {} });
    assert.equal(tool.name, name);
  }
});
