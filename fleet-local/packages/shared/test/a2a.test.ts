import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A2A_CONTENT_TYPE,
  A2A_PROTOCOL_VERSION,
  A2A_SSE_CONTENT_TYPE,
  A2A_VERSION_HEADER,
  HITL_EXTENSION_URI,
  MODEL_METADATA_KEY,
  REASONING_ARTIFACT_ID,
  REASONING_ARTIFACT_NAME,
  THOUGHT_PART_KEY,
  TOOL_APPROVAL_RESPONSE_TYPE,
  a2aFacadeBase,
  isThoughtPart,
  parseStructuredOutputPart,
  sourcesFromToolResult,
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

test('sources come only from a web-shaped tool result', () => {
  // A shell or filesystem result may contain a URL the agent never read.
  assert.deepEqual(sourcesFromToolResult('bash', { stdout: 'see https://example.com/x' }), []);
  assert.deepEqual(sourcesFromToolResult('WebSearch', undefined), []);
});

test('a search result list becomes titled citations, deduped and capped', () => {
  const results = {
    results: [
      { url: 'https://a.example/one', title: ' One ' },
      { link: 'https://b.example/two.md', name: 'Two' },
      { url: 'https://a.example/one.', title: 'Duplicate with trailing punctuation' },
    ],
  };
  const sources = sourcesFromToolResult('web_search', results);
  assert.deepEqual(sources, [
    { url: 'https://a.example/one', title: 'One' },
    { url: 'https://b.example/two.md', title: 'Two' },
  ]);
});

test('a fetched page with no structure still yields its links, with a readable label', () => {
  const sources = sourcesFromToolResult('fetch_url', 'Read https://go.dev/doc and https://go.dev/doc/ again.');
  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://go.dev/doc', 'https://go.dev/doc/'],
  );
  // With no title anywhere, the host and the last path segment identify the page.
  assert.equal(sources[0]?.title, 'go.dev · doc');
});

test('a structured result needs all three of Go\'s signature parts', () => {
  const digest = 'kagent.dev/a2a/output-schema-sha256';
  assert.deepEqual(
    parseStructuredOutputPart({ data: { total: 3 }, mediaType: 'application/json', metadata: { [digest]: 'sha256:abc' } }),
    { value: { total: 3 }, schemaSha256: 'sha256:abc' },
  );
  // The proto JSON binding spells the media type in snake_case.
  assert.ok(parseStructuredOutputPart({ data: 1, media_type: 'application/json;charset=utf-8', metadata: { [digest]: 'x' } }));
  // An ordinary data part — a tool call, a search result — is not a terminal result.
  assert.equal(parseStructuredOutputPart({ data: { total: 3 } }), undefined);
  assert.equal(parseStructuredOutputPart({ data: { total: 3 }, mediaType: 'application/json' }), undefined);
  assert.equal(parseStructuredOutputPart({ data: { total: 3 }, mediaType: 'text/plain', metadata: { [digest]: 'x' } }), undefined);
  assert.equal(parseStructuredOutputPart({ text: 'json', mediaType: 'application/json', metadata: { [digest]: 'x' } }), undefined);
  assert.equal(parseStructuredOutputPart({ data: 1, mediaType: 'application/json', metadata: { [digest]: '' } }), undefined);
});

