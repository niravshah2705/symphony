import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_METADATA_KEY, REASONING_ARTIFACT_ID, THOUGHT_PART_KEY } from '@fleet-local/shared';
import {
  buildThoughtArtifact,
  inspectFrame,
  parseTaskSubpath,
  rewriteAgentCard,
  routeFacadePath,
  turnFromRestBody,
} from '../src/a2a/translate.ts';
import { A2ARequestError } from '../src/a2a/contract.ts';

test('inspectFrame reads the JSON-RPC wrapper the controller actually sends', () => {
  const frame = inspectFrame(
    '{"jsonrpc":"2.0","id":1,"result":{"task":{"id":"t1","contextId":"c1","status":{"state":"TASK_STATE_WORKING"}}}}',
  );
  assert.deepEqual(frame, { view: 'task', contextId: 'c1', taskId: 't1', state: 'working' });
});

test('inspectFrame reads the REST single-key envelope', () => {
  const frame = inspectFrame(
    '{"statusUpdate":{"taskId":"t1","contextId":"c1","status":{"state":"TASK_STATE_INPUT_REQUIRED","message":{"parts":[{"text":"approve this tool call?"}]}}}}',
  );
  assert.equal(frame?.view, 'status-update');
  assert.equal(frame?.state, 'input-required');
  assert.equal(frame?.statusMessage, 'approve this tool call?');
  assert.equal(frame?.taskId, 't1');
});

test('inspectFrame reads the flat kind form and the snake_case keys', () => {
  assert.equal(inspectFrame('{"kind":"artifact-update","taskId":"t1","contextId":"c1","artifact":{"parts":[{"text":"x"}]}}')?.view, 'artifact-update');
  assert.equal(inspectFrame('{"status_update":{"taskId":"t1","contextId":"c1","status":{"state":"TASK_STATE_COMPLETED"}}}')?.state, 'completed');
});

test('inspectFrame reads tool data parts and the HITL metadata payload', () => {
  const call = { data: { id: 'c1', name: 'bash', args: { cmd: 'ls' } }, metadata: { 'kagent.dev/a2a/part-type': 'function_call' } };
  const result = { data: { id: 'c1', name: 'bash', response: { exit: 0 } }, metadata: { 'kagent.dev/a2a/part-type': 'function_response' } };
  const frame = inspectFrame(
    `{"artifactUpdate":{"taskId":"t1","contextId":"c1","artifact":{"parts":[${JSON.stringify(call)},${JSON.stringify(result)}]}}}`,
  );
  assert.deepEqual(frame?.toolCalls, [
    { kind: 'function_call', id: 'c1', name: 'bash', args: { cmd: 'ls' } },
    { kind: 'function_response', id: 'c1', name: 'bash', response: { exit: 0 } },
  ]);
  // A tool part carries no text, so it must not count as an answer.
  assert.equal(frame?.answer, undefined);

  const hitl = {
    statusUpdate: {
      taskId: 't1',
      contextId: 'c1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          parts: [{ text: 'approve this tool call?' }],
          metadata: { 'https://kagent.dev/extensions/hitl/v1': { type: 'tool_approval_request', tools: [{ id: 'c1', call_id: 'c1', name: 'bash' }] } },
        },
      },
    },
  };
  assert.deepEqual(inspectFrame(JSON.stringify(hitl))?.hitl?.type, 'tool_approval_request');
  // An untagged data part is not tool activity.
  const plain = inspectFrame('{"artifactUpdate":{"taskId":"t1","contextId":"c1","artifact":{"parts":[{"data":{"foo":1}}]}}}');
  assert.equal(plain?.toolCalls, undefined);
});

test('inspectFrame reads the structured terminal result off its schema digest', () => {
  const raw = JSON.stringify({
    task: {
      id: 't1',
      contextId: 'c1',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [
        {
          artifactId: 'a1',
          parts: [{ data: { columns: [{ key: 'pkg' }], rows: [{ pkg: 'a2a' }] }, mediaType: 'application/json', metadata: { 'kagent.dev/a2a/output-schema-sha256': 'sha256:9f' } }],
        },
      ],
    },
  });
  assert.deepEqual(inspectFrame(raw)?.structured, {
    value: { columns: [{ key: 'pkg' }], rows: [{ pkg: 'a2a' }] },
    schemaSha256: 'sha256:9f',
  });
  // An untagged data part is tool payload, not the run's result.
  const untagged = JSON.stringify({ task: { id: 't1', artifacts: [{ parts: [{ data: { a: 1 } }] }] } });
  assert.equal(inspectFrame(untagged)?.structured, undefined);
});

test('inspectFrame reads agent-produced files in both JSON spellings', () => {
  const inline = JSON.stringify({
    artifactUpdate: {
      taskId: 't1',
      contextId: 'c1',
      artifact: { artifactId: 'a1', parts: [{ file: { bytes: 'aGVsbG8=', mime_type: 'image/png', name: 'shot.png' } }] },
    },
  });
  assert.deepEqual(inspectFrame(inline)?.files, [{ bytes: 'aGVsbG8=', mimeType: 'image/png', name: 'shot.png' }]);
  // A file is output even though it carries no text the BFF can read.
  assert.equal(inspectFrame(inline)?.producesOutput, true);
  assert.equal(inspectFrame(inline)?.answer, undefined);

  const referenced = JSON.stringify({
    kind: 'artifact-update',
    taskId: 't1',
    artifact: { parts: [{ kind: 'file', file: { uri: 'https://x/y.pdf', mimeType: 'application/pdf' } }] },
  });
  assert.deepEqual(inspectFrame(referenced)?.files, [{ uri: 'https://x/y.pdf', mimeType: 'application/pdf' }]);

  // A file part with neither bytes nor a uri is not a file the UI can show.
  assert.equal(
    inspectFrame(JSON.stringify({ artifactUpdate: { taskId: 't1', artifact: { parts: [{ file: { name: 'x' } }] } } }))?.files,
    undefined,
  );
});

test('inspectFrame separates thinking from the answer', () => {
  const thought = { text: 'let me check the file', metadata: { [THOUGHT_PART_KEY]: true } };
  const answer = { text: 'the answer' };
  const frame = inspectFrame(`{"task":{"id":"t1","contextId":"c1","status":{"state":"TASK_STATE_WORKING"},"artifacts":[{"parts":[${JSON.stringify(thought)},${JSON.stringify(answer)}]}]}}`);
  assert.equal(frame?.thought, 'let me check the file');

  const plain = inspectFrame('{"message":{"messageId":"m1","role":"ROLE_AGENT","parts":[{"text":"just the answer"}]}}');
  assert.equal(plain?.view, 'message');
  assert.equal(plain?.thought, undefined);
});

test('inspectFrame surfaces an in-stream RPC error instead of dropping it', () => {
  const frame = inspectFrame('{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"task not found"}}');
  assert.equal(frame?.view, 'rpc-error');
  assert.equal(frame?.rpcError?.message, 'task not found');
});

test('inspectFrame returns undefined for anything that is not a frame', () => {
  assert.equal(inspectFrame('not json'), undefined);
  assert.equal(inspectFrame('{"foo":1}'), undefined);
  assert.equal(inspectFrame('{"jsonrpc":"2.0","id":1,"result":null}'), undefined);
  // The legacy private frame must parse to nothing, not crash the pump.
  assert.equal(inspectFrame('{"sessionId":"s1","model":"mock"}'), undefined);
});

test('buildThoughtArtifact only fires when the frame can be attributed', () => {
  const withIds = buildThoughtArtifact({ text: 'thinking', taskId: 't1', contextId: 'c1', append: false });
  assert.ok(withIds);
  const parsed = JSON.parse(withIds) as { artifactUpdate: { artifact: { artifactId: string }; append: boolean } };
  assert.equal(parsed.artifactUpdate.artifact.artifactId, REASONING_ARTIFACT_ID);
  assert.equal(parsed.artifactUpdate.append, false);

  assert.equal(buildThoughtArtifact({ text: 'thinking', taskId: undefined, contextId: 'c1', append: false }), undefined);
  assert.equal(buildThoughtArtifact({ text: '', taskId: 't1', contextId: 'c1', append: true }), undefined);
});

test('turnFromRestBody consumes the model hint instead of forwarding it', () => {
  const turn = turnFromRestBody({
    message: {
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ kind: 'text', text: 'hello' }],
      contextId: 'c1',
      metadata: { [MODEL_METADATA_KEY]: 'claude', 'trace_tags': ['chat'] },
    },
  });
  assert.equal(turn.modelId, 'claude');
  assert.equal(turn.message.messageId, 'm1');
  assert.equal(turn.message.contextId, 'c1');
  // The marker is ours; kagent must not see an unknown key it might reject.
  assert.deepEqual(turn.message.metadata, { trace_tags: ['chat'] });
  assert.equal(turn.pushConfigRequested, false);
});

test('turnFromRestBody accepts a resume and the snake_case ids', () => {
  const turn = turnFromRestBody({ message: { role: 'user', parts: [{ text: 'yes' }], task_id: 't9', context_id: 'c9' } });
  assert.equal(turn.message.taskId, 't9');
  assert.equal(turn.message.contextId, 'c9');
  assert.equal(turn.message.parts.length, 1);
});

test('turnFromRestBody refuses what it cannot relay, loudly', () => {
  const cases: unknown[] = [
    undefined,
    {},
    { message: {} },
    { message: { parts: [] } },
    { message: { role: 'ROLE_AGENT', parts: [{ text: 'x' }] } },
    { message: { parts: [{ kind: 'data', data: {} }] } },
    { message: { parts: [{ metadata: {} }] } },
    { message: { parts: ['plain string'] } },
  ];
  for (const body of cases) {
    assert.throws(() => turnFromRestBody(body), A2ARequestError, JSON.stringify(body));
  }
});

test('a push-notification request is detected so it can be refused, not dropped', () => {
  const turn = turnFromRestBody({
    message: { parts: [{ text: 'x' }] },
    configuration: { taskPushNotificationConfig: { url: 'https://example.invalid/hook' } },
  });
  assert.equal(turn.pushConfigRequested, true);
});

test('parseTaskSubpath handles the colon that find-my-way cannot pattern-match', () => {
  assert.deepEqual(parseTaskSubpath('t1:cancel'), { taskId: 't1', action: 'cancel' });
  assert.deepEqual(parseTaskSubpath('t1:subscribe'), { taskId: 't1', action: 'subscribe' });
  assert.deepEqual(parseTaskSubpath('t1'), { taskId: 't1', action: 'get' });
  assert.deepEqual(parseTaskSubpath('/t1/pushNotificationConfigs'), { taskId: 't1', action: 'push-config', configId: undefined });
  assert.deepEqual(parseTaskSubpath('t1/pushNotificationConfigs/p1'), { taskId: 't1', action: 'push-config', configId: 'p1' });
  assert.deepEqual(parseTaskSubpath('t%2F1'), { taskId: 't/1', action: 'get' });
  assert.deepEqual(parseTaskSubpath('t1?historyLength=5'), { taskId: 't1', action: 'get' });
  assert.equal(parseTaskSubpath('t1/extra').action, 'unsupported');
  assert.equal(parseTaskSubpath('').action, 'unsupported');
});

test('routeFacadePath is the whole URL space of the facade', () => {
  assert.deepEqual(routeFacadePath('.well-known/agent-card.json'), { kind: 'agent-card' });
  assert.deepEqual(routeFacadePath('/message:stream'), { kind: 'stream' });
  assert.deepEqual(routeFacadePath('message:send'), { kind: 'send' });
  assert.deepEqual(routeFacadePath('.well-known/extended-agent-card.json'), { kind: 'extended-card' });
  assert.deepEqual(routeFacadePath('tasks/t1:cancel'), { kind: 'task', taskId: 't1', action: 'cancel', configId: undefined });
  assert.deepEqual(routeFacadePath('tasks/t1'), { kind: 'task', taskId: 't1', action: 'get', configId: undefined });
  assert.deepEqual(routeFacadePath('whatever'), { kind: 'unknown', path: 'whatever' });
});

test('rewriteAgentCard moves only the addresses', () => {
  const base = 'https://app.fleet.dev/api/a2a/orgs/o/projects/p';
  const card = {
    name: 'test-agent',
    description: 'keeps working',
    url: 'http://kagent-controller.kagent.svc.cluster.local:8083/agents/org-test/test-agent',
    supportedInterfaces: [
      { url: 'http://kagent-controller.kagent.svc/agents/org-test/test-agent', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'http://kagent-controller.kagent.svc/agents/org-test/test-agent', protocolBinding: 'GRPC', tenant: 'org-test/test-agent' },
    ],
    capabilities: { streaming: true, extensions: [{ uri: 'https://kagent.dev/extensions/hitl/v1' }] },
    skills: [{ id: 'chat', name: 'Chat', tags: ['demo'], inputModes: [], outputModes: [] }],
  };
  const out = rewriteAgentCard(card, base);
  assert.equal(out.url, base);
  const ifaces = out.supportedInterfaces as { url: string; tenant?: string }[];
  assert.deepEqual(ifaces.map((i) => i.url), [base, base]);
  // The GRPC tenant stays: the client never dials it, and stripping it would
  // change what the controller advertises for no benefit.
  assert.equal(ifaces[1]?.tenant, 'org-test/test-agent');
  assert.deepEqual(out.skills, card.skills);
  assert.deepEqual(out.capabilities, card.capabilities);
  assert.equal(out.name, 'test-agent');
  assert.equal(out.description, 'keeps working');
});

test('rewriteAgentCard refuses a card the client could not parse', () => {
  // The library rejects a nameless card with "Invalid A2A agent card response";
  // passing that through would leave the browser with an unexplainable failure.
  assert.throws(() => rewriteAgentCard({ description: 'no name' }, 'https://x/y'), A2ARequestError);
  assert.throws(() => rewriteAgentCard('{', 'https://x/y'), A2ARequestError);
  assert.throws(() => rewriteAgentCard(undefined, 'https://x/y'), A2ARequestError);
  const legacy = rewriteAgentCard({ name: 'a', additionalInterfaces: [{ url: 'http://inside.svc' }] }, 'https://x/y');
  assert.equal((legacy.additionalInterfaces as { url: string }[])[0]?.url, 'https://x/y');
});
