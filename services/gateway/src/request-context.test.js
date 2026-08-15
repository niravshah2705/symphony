'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requestContext,
  contextHeaders,
  forwardRequestContext,
  enforcePinnedOrganization,
  requireOrganizationContext,
} = require('./request-context');

function req(headers = {}) {
  return { headers, get: (name) => headers[String(name).toLowerCase()] };
}

test('reads and forwards the exact organization/project context headers', () => {
  const request = req({
    'x-ai-fleet-organization-id': 'org-1',
    'x-ai-fleet-project-id': 'project:2',
  });
  assert.deepEqual(requestContext(request), { organizationId: 'org-1', projectId: 'project:2', llmGateway: '' });
  assert.deepEqual(contextHeaders(requestContext(request)), {
    'x-ai-fleet-organization-id': 'org-1',
    'x-ai-fleet-project-id': 'project:2',
  });
  assert.deepEqual(forwardRequestContext(request, { accept: 'application/json' }), {
    accept: 'application/json',
    'x-ai-fleet-organization-id': 'org-1',
    'x-ai-fleet-project-id': 'project:2',
  });
});

test('drops malformed or unbounded context ids', () => {
  assert.deepEqual(requestContext(req({
    'x-ai-fleet-organization-id': 'bad value\n',
    'x-ai-fleet-project-id': 'x'.repeat(161),
  })), { organizationId: '', projectId: '', llmGateway: '' });
});

test('llm-gateway flag: honored only when the deployment has the gateway enabled', () => {
  const request = req({
    'x-ai-fleet-organization-id': 'org-1',
    'x-ai-fleet-llm-gateway': ' LangSmith ',
  });
  // Default deployment (gate off): the header is dropped at ingestion.
  assert.equal(requestContext(request).llmGateway, '');
  // Gate on: the value is normalized and surfaced.
  assert.equal(requestContext(request, { llmGatewayEnabled: true }).llmGateway, 'langsmith');
});

test('llm-gateway flag: unknown selector values are ignored even when enabled', () => {
  const request = req({ 'x-ai-fleet-llm-gateway': 'other-router' });
  assert.equal(requestContext(request, { llmGatewayEnabled: true }).llmGateway, '');
});

test('llm-gateway flag: survives the validated fleetContext branch and forwards', () => {
  const request = {
    ...req({ 'x-ai-fleet-llm-gateway': 'langsmith' }),
    fleetContext: { organizationId: 'org-1', projectId: 'p-1' },
  };
  const context = requestContext(request, { llmGatewayEnabled: true });
  assert.deepEqual(context, { organizationId: 'org-1', projectId: 'p-1', llmGateway: 'langsmith' });
  assert.deepEqual(contextHeaders(context), {
    'x-ai-fleet-organization-id': 'org-1',
    'x-ai-fleet-project-id': 'p-1',
    'x-ai-fleet-llm-gateway': 'langsmith',
  });
});

test('dedicated gateway rejects a different selected organization', () => {
  const middleware = enforcePinnedOrganization('org-1');
  let nexted = false;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  middleware(req({ 'x-ai-fleet-organization-id': 'org-2' }), res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'context_not_found');

  middleware(req({ 'x-ai-fleet-organization-id': 'org-1' }), res, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('operational routes require a selected org except in trusted local mode', () => {
  const middleware = requireOrganizationContext();
  const response = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const missing = { ...req(), auth: { authenticated: true, mode: 'firebase' } };
  const denied = response();
  middleware(missing, denied, () => assert.fail('must not continue'));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'organization_context_required');

  let selectedNext = false;
  middleware({
    ...req(),
    auth: { authenticated: true, mode: 'firebase' },
    fleetContext: { organizationId: 'org-1', projectId: '' },
  }, response(), () => { selectedNext = true; });
  assert.equal(selectedNext, true);

  let localNext = false;
  middleware({ ...req(), auth: { authenticated: true, mode: 'disabled' } }, response(), () => { localNext = true; });
  assert.equal(localNext, true);
});
