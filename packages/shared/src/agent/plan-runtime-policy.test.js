'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isMandatoryPlanningWorkflowError } = require('./plan');
const { AgentRuntimeError } = require('./runtimes');
const { PolicyDeniedError } = require('./settings-policy');

test('planning draft fails closed for policy and selected-runtime failures', () => {
  assert.equal(
    isMandatoryPlanningWorkflowError(new PolicyDeniedError('harness', 'codex-sdk')),
    true,
  );
  assert.equal(
    isMandatoryPlanningWorkflowError(new AgentRuntimeError('SDK unavailable', 'runtime_unavailable', 503)),
    true,
  );
  assert.equal(
    isMandatoryPlanningWorkflowError(new Error('optional draft formatting failed')),
    false,
  );
});
