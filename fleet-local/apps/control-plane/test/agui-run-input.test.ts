import test from 'node:test';
import assert from 'node:assert/strict';
import { turnFromRunAgentInput } from '../src/agui/runinput.ts';
import { A2ARequestError } from '../src/a2a/contract.ts';

interface Rejected {
  status: number;
  reason: string | undefined;
  message: string;
}

// The parser's contract is the refusal, not just the shape: the browser renders
// `reason` and the operator greps for it, so a test that only asserted "throws"
// would let a reason word drift without anything noticing.
function refuse(body: unknown): Rejected {
  try {
    turnFromRunAgentInput(body);
  } catch (err) {
    assert.ok(err instanceof A2ARequestError, `expected an A2ARequestError, got ${String(err)}`);
    return { status: err.statusCode, reason: err.info?.reason, message: err.message };
  }
  assert.fail('expected the input to be refused');
}

const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  threadId: 'thread-1',
  runId: 'run-1',
  state: {},
  messages: [{ id: 'm1', role: 'user', content: 'summarise the repo' }],
  tools: [],
  context: [],
  forwardedProps: {},
  ...over,
});

test('a plain run becomes a turn on the thread handle, with no task to resume', () => {
  const { run, turn } = turnFromRunAgentInput(input());
  assert.deepEqual(run, { threadId: 'thread-1', runId: 'run-1' });
  assert.equal(turn.threadId, 'thread-1');
  assert.equal(turn.message.role, 'ROLE_USER');
  assert.deepEqual(turn.message.parts, [{ text: 'summarise the repo' }]);
  assert.equal(turn.message.taskId, undefined);
  assert.equal(turn.message.contextId, undefined, 'the client never learns the A2A context id');
  assert.equal(turn.pushConfigRequested, false);
  assert.ok(turn.message.messageId, 'a message id is minted, not borrowed from the transcript');
});

test('the LAST user message is this turn; earlier ones are kagent history', () => {
  const { turn } = turnFromRunAgentInput(
    input({
      messages: [
        { id: 'm1', role: 'user', content: 'first' },
        { id: 'm2', role: 'assistant', content: 'answer' },
        { id: 'm3', role: 'user', content: 'and now the tests' },
      ],
    }),
  );
  assert.deepEqual(turn.message.parts, [{ text: 'and now the tests' }]);
});

test('parts content keeps each text part distinct', () => {
  const { turn } = turnFromRunAgentInput(
    input({ messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }),
  );
  assert.deepEqual(turn.message.parts, [{ text: 'a' }, { text: 'b' }]);
});

test('an image part becomes an A2A file part, base64 and mime intact', () => {
  const { turn } = turnFromRunAgentInput(
    input({
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { type: 'data', value: 'aGVsbG8=', mimeType: 'image/png' }, metadata: { filename: 'shot.png' } },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(turn.message.parts, [
    { text: 'look at this' },
    { file: { bytes: 'aGVsbG8=', mimeType: 'image/png', name: 'shot.png' } },
  ]);
});

test('a url-sourced part rides as a file uri, no fetch here', () => {
  const { turn } = turnFromRunAgentInput(
    input({
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'image', source: { type: 'url', value: 'https://x/y.png', mimeType: 'image/png' } }] }],
    }),
  );
  assert.deepEqual(turn.message.parts, [{ file: { uri: 'https://x/y.png', mimeType: 'image/png' } }]);
});

test('attachment limits: type allowlist, 5 MB decoded, no provider file ids', () => {
  const zip = refuse(
    input({ messages: [{ id: 'm1', role: 'user', content: [{ type: 'document', source: { type: 'data', value: 'AAAA', mimeType: 'application/zip' } }] }] }),
  );
  assert.equal(zip.status, 400);
  assert.equal(zip.reason, 'attachment_type_unsupported');

  const big = refuse(
    input({ messages: [{ id: 'm1', role: 'user', content: [{ type: 'image', source: { type: 'data', value: 'A'.repeat(8 * 1024 * 1024), mimeType: 'image/png' } }] }] }),
  );
  assert.equal(big.status, 413);
  assert.equal(big.reason, 'attachment_too_large');

  const ref = refuse(
    input({ messages: [{ id: 'm1', role: 'user', content: [{ type: 'document', source: { type: 'file', value: 'file-123', mimeType: 'application/pdf' } }] }] }),
  );
  assert.equal(ref.status, 400);
  assert.equal(ref.reason, 'attachment_reference_unsupported');
});

test('an unknown content part kind is still refused', () => {
  const refused = refuse(
    input({ messages: [{ id: 'm1', role: 'user', content: [{ type: 'reasoning', text: 'nope' }] }] }),
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.reason, 'multimodal_content_unsupported');
});

test('the model choice arrives on forwardedProps and nowhere else', () => {
  assert.equal(turnFromRunAgentInput(input({ forwardedProps: { 'fleet.dev/model': 'nemotron' } })).turn.modelId, 'nemotron');
  assert.equal(turnFromRunAgentInput(input()).turn.modelId, undefined, 'absent means the catalog default');
});

test('a resume answers the interrupt by naming the task and carrying the text', () => {
  const { turn } = turnFromRunAgentInput(
    input({
      messages: [],
      resume: [{ interruptId: 'task-9', status: 'resolved', payload: 'yes, run it' }],
    }),
  );
  assert.equal(turn.message.taskId, 'task-9', 'the interrupt id IS the paused A2A task');
  assert.deepEqual(turn.message.parts, [{ text: 'yes, run it' }]);
  assert.equal(turn.threadId, 'thread-1');
});

test('a resume needs no transcript', () => {
  const body = input({ resume: [{ interruptId: 'task-9', status: 'resolved', payload: 'ok' }] });
  delete body.messages;
  assert.equal(turnFromRunAgentInput(body).turn.message.taskId, 'task-9');
});

test('abandoning an answer cancels the paused task instead of streaming a turn', () => {
  const { turn } = turnFromRunAgentInput(
    input({ messages: [], resume: [{ interruptId: 'task-9', status: 'cancelled' }] }),
  );
  assert.equal(turn.cancelTaskId, 'task-9');
  assert.equal(turn.message.taskId, 'task-9', 'the paused session is still resolved by task');
  assert.deepEqual(turn.message.parts, [], 'nothing is said to the agent when nothing is answered');
});

test('a structured tool_approval_response rides as declared HITL metadata', () => {
  const payload = {
    type: 'tool_approval_response',
    approvals: [
      { id: 'call-1', approved: true },
      { id: 'call-2', approved: false, rejection_reason: 'too destructive' },
    ],
  };
  const { turn } = turnFromRunAgentInput(
    input({ messages: [], resume: [{ interruptId: 'task-9', status: 'resolved', payload }] }),
  );
  assert.equal(turn.message.taskId, 'task-9');
  assert.deepEqual(turn.message.extensions, ['https://kagent.dev/extensions/hitl/v1'], 'kagent only parses the payload when the message declares the extension');
  assert.deepEqual(turn.message.metadata?.['https://kagent.dev/extensions/hitl/v1'], payload);
  assert.match(String(turn.message.parts[0]?.text), /Approved 1, rejected 1 tool call\(s\)/);
});

test('a structured ask_user_response answers positionally, with its correlation id', () => {
  const payload = { type: 'ask_user_response', id: 'q-1', answers: [{ answer: ['Postgres'] }, { answer: ['yes', 'now'] }] };
  const { turn } = turnFromRunAgentInput(
    input({ messages: [], resume: [{ interruptId: 'task-9', status: 'resolved', payload }] }),
  );
  assert.deepEqual(turn.message.metadata?.['https://kagent.dev/extensions/hitl/v1'], payload);
  assert.equal(turn.message.parts[0]?.text, 'Postgres | yes, now');
});

test('a malformed HITL payload is refused out loud, never forwarded', () => {
  const cases: Record<string, unknown>[] = [
    { approved: true }, // not a kagent response type at all
    { type: 'tool_approval_response', approvals: [] }, // decides nothing
    { type: 'tool_approval_response', approvals: [{ id: '', approved: true }] }, // Go requires the id
    { type: 'tool_approval_response', approvals: [{ id: 'c1', approved: true, rejection_reason: 'x' }] }, // contradiction
    { type: 'ask_user_response', answers: [{ answer: [] }] }, // no correlation id, empty answer
  ];
  for (const payload of cases) {
    const refused = refuse(input({ messages: [], resume: [{ interruptId: 'task-9', status: 'resolved', payload }] }));
    assert.equal(refused.status, 400, `payload ${JSON.stringify(payload)} must be refused`);
    assert.equal(refused.reason, 'resume_payload_unsupported');
  }
});

test('one question at a time', () => {
  const refused = refuse(
    input({
      messages: [],
      resume: [
        { interruptId: 'a', status: 'resolved', payload: 'x' },
        { interruptId: 'b', status: 'resolved', payload: 'y' },
      ],
    }),
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.reason, 'multiple_interrupts');
});

test('a resume without an id cannot name a task', () => {
  assert.equal(refuse(input({ messages: [], resume: [{ status: 'resolved', payload: 'x' }] })).reason, 'bad_resume');
  assert.equal(refuse(input({ messages: [], resume: [] })).reason, 'empty_resume');
});

test('the two ids the run is built on are required', () => {
  assert.equal(refuse(input({ threadId: undefined })).reason, 'missing_thread_id');
  assert.equal(refuse(input({ runId: undefined })).reason, 'missing_run_id');
});

test('an empty or non-user transcript is refused with the reason it is empty', () => {
  assert.equal(refuse(input({ messages: [] })).reason, 'no_user_message');
  assert.equal(refuse(input({ messages: [{ id: 'm1', role: 'assistant', content: 'hi' }] })).reason, 'no_user_message');
  assert.equal(refuse(input({ messages: [{ id: 'm1', role: 'user', content: '' }] })).reason, 'empty_message');
  assert.equal(refuse(input({ messages: 'summarise the repo' })).reason, 'no_user_message');
});

test('a body that is not an object is refused before anything is resolved', () => {
  for (const body of [undefined, null, 'x', 42, []]) {
    const refused = refuse(body);
    assert.equal(refused.status, 400);
    assert.equal(refused.reason, 'bad_run_input');
  }
});

test('content that is neither text nor parts says so', () => {
  const refused = refuse(input({ messages: [{ id: 'm1', role: 'user', content: 7 }] }));
  assert.equal(refused.reason, 'bad_content');
});
