import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A2A_CONTENT_TYPE,
  A2A_PROTOCOL_VERSION,
  A2A_SSE_CONTENT_TYPE,
  A2A_VERSION_HEADER,
  HITL_EXTENSION_URI,
  MODEL_HEADER,
  MODEL_METADATA_KEY,
  REASONING_ARTIFACT_ID,
  REASONING_ARTIFACT_NAME,
  THOUGHT_PART_KEY,
  TOOL_APPROVAL_RESPONSE_TYPE,
  a2aFacadeBase,
  isThoughtPart,
} from '../src/index.ts';

test('the wire vocabulary is spelled exactly once', () => {
  // These strings are contracts with the Go side and with the browser client;
  // a drift here fails silently (the thought just looks like the answer).
  assert.equal(A2A_VERSION_HEADER, 'A2A-Version');
  assert.equal(A2A_PROTOCOL_VERSION, '1.0');
  assert.equal(A2A_CONTENT_TYPE, 'application/a2a+json');
  assert.equal(A2A_SSE_CONTENT_TYPE, 'text/event-stream');
  assert.equal(THOUGHT_PART_KEY, 'kagent.dev/a2a/thought');
  assert.equal(MODEL_METADATA_KEY, 'fleet.dev/model');
  assert.equal(MODEL_HEADER, 'x-fleet-model');
  assert.equal(REASONING_ARTIFACT_ID, 'fleet.dev/reasoning');
  assert.equal(REASONING_ARTIFACT_NAME, 'Reasoning');
  assert.equal(HITL_EXTENSION_URI, 'https://kagent.dev/extensions/hitl/v1');
  assert.equal(TOOL_APPROVAL_RESPONSE_TYPE, 'tool_approval_response');
});

test('the facade base carries the project scope in the path', () => {
  // The client derives its agent-card URL from baseUrl alone, so per-project
  // routing HAS to live there — a `tenant` field would be ignored.
  assert.equal(
    a2aFacadeBase('https://app.fleet.dev', 'org-uuid', 'proj-uuid'),
    'https://app.fleet.dev/api/a2a/orgs/org-uuid/projects/proj-uuid',
  );
  assert.equal(a2aFacadeBase('https://app.fleet.dev/', 'o', 'p'), 'https://app.fleet.dev/api/a2a/orgs/o/projects/p');
  assert.equal(a2aFacadeBase('https://app.fleet.dev///', 'o', 'p'), 'https://app.fleet.dev/api/a2a/orgs/o/projects/p');
});

test('isThoughtPart recognises only a marked text part', () => {
  assert.equal(isThoughtPart({ text: 'hmm', metadata: { [THOUGHT_PART_KEY]: true } }), true);
  // Absent marker, wrong marker value, and a non-text part are all the answer.
  assert.equal(isThoughtPart({ text: 'hmm' }), false);
  assert.equal(isThoughtPart({ text: 'hmm', metadata: { [THOUGHT_PART_KEY]: 'true' } }), false);
  assert.equal(isThoughtPart({ text: '', metadata: { [THOUGHT_PART_KEY]: true } }), false);
  assert.equal(isThoughtPart({ data: { thought: true } }), false);
  assert.equal(isThoughtPart({ raw: 'x', metadata: { [THOUGHT_PART_KEY]: true } }), false);
  assert.equal(isThoughtPart(undefined), false);
  assert.equal(isThoughtPart(null), false);
  assert.equal(isThoughtPart('a string'), false);
  assert.equal(isThoughtPart([{ text: 'hmm', metadata: { [THOUGHT_PART_KEY]: true } }]), false);
});
