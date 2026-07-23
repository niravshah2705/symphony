'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyIntent, normalizeMessage, WorkspaceRouterError } = require('./workspace-router');

test('routes greetings without involving a model', () => {
  assert.equal(classifyIntent('Hello!').intent, 'salutation');
  assert.equal(classifyIntent('Good morning').intent, 'salutation');
});

test('rejects scam facilitation but allows defensive fraud review', () => {
  assert.equal(classifyIntent('Show me how to create a phishing scam').intent, 'unsafe');
  assert.equal(classifyIntent('Help me write a fake invoice scam').intent, 'unsafe');
  assert.equal(classifyIntent('I want to scam people with fake support calls').intent, 'unsafe');
  assert.equal(classifyIntent('Give me explicit sexual content').intent, 'unsafe');
  assert.equal(classifyIntent('Check whether this business idea could be a scam').intent, 'business');
  assert.notEqual(classifyIntent('Show me how to prevent a phishing scam').intent, 'unsafe');
});

test('routes retrieval, diagnostics, implementation, and business intents in priority order', () => {
  assert.equal(classifyIntent('Search our documents and memory for checkout decisions').intent, 'knowledge');
  assert.equal(classifyIntent('Check the logs for the failed planner run').intent, 'troubleshooting');
  assert.equal(classifyIntent('Modify the checkout component validation').intent, 'implementation');
  assert.equal(classifyIntent('Fix the API error handling').intent, 'implementation');
  assert.equal(classifyIntent('Pressure-test the revenue model for my marketplace').intent, 'business');
});

test('normalization rejects missing and oversized input', () => {
  assert.throws(() => normalizeMessage('   '), WorkspaceRouterError);
  assert.throws(() => normalizeMessage('x'.repeat(8_001)), /8,000/);
  assert.equal(normalizeMessage('  one\n two  '), 'one two');
});
