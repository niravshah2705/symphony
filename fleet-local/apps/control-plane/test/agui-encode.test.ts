// The mapping table, tested as a table: one case per row, plus an oracle that
// replays a whole stream through the ordering rules the browser's @ag-ui/client
// enforces. A stream that violates those rules is rejected outright and reaches
// the user as a dead conversation, so the shape matters here more than the
// wording.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnEncoder } from '../src/agui/encode.ts';
import type { TurnEnd } from '../src/agui/encode.ts';
import type { WireFrame } from '../src/a2a/translate.ts';
import type { Settlement } from '../src/a2a/contract.ts';

interface Emit {
  type: string;
  [key: string]: unknown;
}

const IDENTITY = { threadId: 'ctx-1', runId: 'task-1' };

const settle = (outcome: Settlement['outcome'], reason: string | null = null): Settlement => ({ outcome, reason });
const types = (events: readonly Emit[]): string[] => events.map((event) => event.type);
const answer = (text: string, extra: Partial<WireFrame> = {}): WireFrame => ({ view: 'artifact-update', answer: text, ...extra });
const thought = (text: string): WireFrame => ({ view: 'artifact-update', thought: text });
const status = (state: string, text: string): WireFrame => ({ view: 'status-update', state, statusMessage: text });

const toolCallFrame = (id: string, name = 'bash', args: unknown = { cmd: 'ls' }): WireFrame => ({
  view: 'artifact-update',
  toolCalls: [{ kind: 'function_call', id, name, args }],
});
const toolResultFrame = (id: string, name = 'bash', response: unknown = { exit: 0 }): WireFrame => ({
  view: 'artifact-update',
  toolCalls: [{ kind: 'function_response', id, name, response }],
});

// started + frames, without settling: for asserting the opening of a stream.
function streamed(...frames: WireFrame[]): Emit[] {
  const encoder = createTurnEncoder(IDENTITY);
  return [...encoder.started(), ...frames.flatMap((frame) => encoder.frame(frame))] as Emit[];
}

// started + frames + end, which is the whole stream the browser receives — and
// therefore the whole stream the oracle below judges.
function ended(frames: WireFrame[], end: TurnEnd): Emit[] {
  const encoder = createTurnEncoder(IDENTITY);
  const events = [
    ...encoder.started(),
    ...frames.flatMap((frame) => encoder.frame(frame)),
    ...encoder.end(end),
  ] as Emit[];
  const problem = verifySequence(events);
  assert.equal(problem, undefined, `invalid sequence: ${problem} — ${JSON.stringify(types(events))}`);
  return events;
}

// What the reference client checks before it hands a single event to the
// runtime: a run opens with RUN_STARTED, a message or thought must be open
// before it is written to and closed before it is reopened, and nothing may
// follow the terminal event. Returning the offence makes a failure readable
// instead of "event 7 is wrong".
function verifySequence(events: readonly Emit[]): string | undefined {
  if (events.length === 0) return 'the run produced no events';
  const first = events[0];
  if (first?.type !== 'RUN_STARTED') return `a run must open with RUN_STARTED, saw ${first?.type}`;
  let textOpen: string | undefined;
  let thoughtOpen: string | undefined;
  // 'called' = started, args may follow; 'ended' = result may follow.
  const calls = new Map<string, 'called' | 'ended'>();
  for (let i = 1; i < events.length; i += 1) {
    const event = events[i];
    if (!event) return 'missing event';
    const terminal = event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
    if (i === events.length - 1) {
      if (!terminal) return `a run must end with RUN_FINISHED or RUN_ERROR, saw ${event.type}`;
    } else if (terminal) {
      return `${event.type} at ${i} is terminal but ${events.length - i - 1} more event(s) follow`;
    }
    const id = typeof event.messageId === 'string' ? event.messageId : undefined;
    const callId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
    if (event.type === 'TOOL_CALL_START') {
      if (!callId) return 'TOOL_CALL_START without a toolCallId';
      if (calls.has(callId)) return `TOOL_CALL_START reopens ${callId}`;
      calls.set(callId, 'called');
    } else if (event.type === 'TOOL_CALL_ARGS') {
      if (calls.get(callId ?? '') !== 'called') return 'TOOL_CALL_ARGS without an open tool call';
    } else if (event.type === 'TOOL_CALL_END') {
      if (calls.get(callId ?? '') !== 'called') return 'TOOL_CALL_END without an open tool call';
      calls.set(callId ?? '', 'ended');
    } else if (event.type === 'TOOL_CALL_RESULT') {
      if (calls.get(callId ?? '') !== 'ended') return 'TOOL_CALL_RESULT before TOOL_CALL_END';
      calls.delete(callId ?? '');
    } else if (event.type === 'TEXT_MESSAGE_START') {
      if (textOpen) return `TEXT_MESSAGE_START while ${textOpen} is still open`;
      textOpen = id;
    } else if (event.type === 'TEXT_MESSAGE_CONTENT') {
      if (!textOpen) return 'TEXT_MESSAGE_CONTENT without TEXT_MESSAGE_START';
      if (id !== textOpen) return `TEXT_MESSAGE_CONTENT for ${id} while ${textOpen} is open`;
    } else if (event.type === 'TEXT_MESSAGE_END') {
      if (!textOpen) return 'TEXT_MESSAGE_END without an open message';
      textOpen = undefined;
    } else if (event.type === 'REASONING_START') {
      if (thoughtOpen) return 'REASONING_START while a thought is already open';
      thoughtOpen = id;
    } else if (event.type.startsWith('REASONING_MESSAGE_')) {
      if (!thoughtOpen) return `${event.type} without an open thought`;
    } else if (event.type === 'REASONING_END') {
      if (!thoughtOpen) return 'REASONING_END without an open thought';
      thoughtOpen = undefined;
    }
  }
  if (textOpen) return `message ${textOpen} was never closed`;
  if (thoughtOpen) return `thought ${thoughtOpen} was never closed`;
  return undefined;
}

const field = (event: Emit | undefined, key: string): Record<string, unknown> =>
  (event?.[key] ?? {}) as Record<string, unknown>;
const outcomeOf = (event: Emit | undefined): Record<string, unknown> => field(event, 'outcome');
const resultOf = (event: Emit | undefined): Record<string, unknown> => field(event, 'result');
const interruptsOf = (event: Emit | undefined): Record<string, unknown>[] =>
  (outcomeOf(event).interrupts ?? []) as Record<string, unknown>[];

test('a run opens with RUN_STARTED carrying the thread and run handles', () => {
  const [event] = streamed();
  assert.equal(event?.type, 'RUN_STARTED');
  assert.equal(event?.threadId, 'ctx-1');
  assert.equal(event?.runId, 'task-1');
});

test('artifact text becomes message content, not an artifact the UI must dig for', () => {
  const events = streamed(answer('mock reply'));
  assert.deepEqual(types(events), ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
  assert.equal(events[2]?.delta, 'mock reply');
  assert.equal(events[2]?.messageId, 'task-1-answer');
});

test('a bare A2A Message reply streams the same way', () => {
  assert.deepEqual(types(streamed({ view: 'message', answer: 'hello' })), [
    'RUN_STARTED',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
  ]);
});

test('streamed deltas accumulate under one message id', () => {
  const events = streamed(answer('mock '), answer('reply'));
  assert.deepEqual(types(events), [
    'RUN_STARTED',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_CONTENT',
  ]);
  assert.equal(new Set(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.messageId)).size, 1);
});

test('reasoning becomes REASONING events and closes when the answer starts', () => {
  assert.deepEqual(types(streamed(thought('checking the file'), answer('done'))), [
    'RUN_STARTED',
    'REASONING_START',
    'REASONING_MESSAGE_START',
    'REASONING_MESSAGE_CONTENT',
    'REASONING_MESSAGE_END',
    'REASONING_END',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
  ]);
});

test('reasoning that never reaches an answer still closes before the run ends', () => {
  const events = ended([thought('thinking')], { settlement: settle('completed'), state: 'completed' });
  assert.deepEqual(types(events).slice(-4), [
    'REASONING_MESSAGE_CONTENT',
    'REASONING_MESSAGE_END',
    'REASONING_END',
    'RUN_FINISHED',
  ]);
});

test('a function_call part becomes the START/ARGS/END sequence', () => {
  const events = ended([toolCallFrame('call-1')], { settlement: settle('completed'), state: 'completed' });
  assert.deepEqual(types(events).slice(1, 4), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END']);
  assert.equal(events[1]?.toolCallId, 'call-1');
  assert.equal(events[1]?.toolCallName, 'bash');
  assert.deepEqual(JSON.parse(String(events[2]?.delta)), { cmd: 'ls' });
});

test('a function_response part closes its call with a result', () => {
  const events = ended([toolCallFrame('call-1'), toolResultFrame('call-1')], {
    settlement: settle('completed'),
    state: 'completed',
  });
  const result = events.find((event) => event.type === 'TOOL_CALL_RESULT');
  assert.equal(result?.toolCallId, 'call-1');
  assert.equal(result?.role, 'tool');
  assert.deepEqual(JSON.parse(String(result?.content)), { exit: 0 });
});

test('a result whose call was never streamed still opens a closed call first', () => {
  const events = ended([toolResultFrame('call-9', 'read')], { settlement: settle('completed'), state: 'completed' });
  assert.deepEqual(types(events).slice(1, 4), ['TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT']);
});

test('the final-task replay of a tool artifact does not double-emit', () => {
  const events = ended([toolCallFrame('call-1'), toolCallFrame('call-1'), answer('done')], {
    settlement: settle('completed'),
    state: 'completed',
  });
  assert.equal(events.filter((event) => event.type === 'TOOL_CALL_START').length, 1);
});

test('tools do not interrupt an open answer: text stays one message', () => {
  const events = ended(
    [answer('running '), toolCallFrame('call-1'), toolResultFrame('call-1'), answer('done')],
    { settlement: settle('completed'), state: 'completed' },
  );
  assert.deepEqual(types(events).filter((type) => type.startsWith('TEXT_MESSAGE')), [
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
  ]);
  const contents = events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT').map((event) => event.delta);
  assert.deepEqual(contents, ['running ', 'done']);
});

test('a failed frame emits no tool card, only the error run', () => {
  const events = ended([{ ...toolCallFrame('call-1'), state: 'failed', statusMessage: 'boom' }], {
    settlement: settle('failed', 'boom'),
    state: 'failed',
  });
  assert.equal(events.some((event) => event.type.startsWith('TOOL_CALL_')), false);
  assert.equal(events.at(-1)?.type, 'RUN_ERROR');
});

const fileFrame = (...files: NonNullable<WireFrame['files']>): WireFrame => ({ view: 'artifact-update', files });

test('an inline file becomes one CUSTOM artifact event and a URI keeps its address', () => {
  const events = ended(
    [fileFrame({ bytes: 'aGVsbG8=', mimeType: 'image/png', name: 'shot.png' }), fileFrame({ uri: 'https://x/y.pdf', mimeType: 'application/pdf' })],
    { settlement: settle('completed'), state: 'completed' },
  );
  const custom = events.filter((event) => event.type === 'CUSTOM');
  assert.deepEqual(custom.map((event) => event.name), ['fleet.dev/file', 'fleet.dev/file']);
  assert.deepEqual(custom[0]?.value, { dataUri: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png', name: 'shot.png' });
  assert.deepEqual(custom[1]?.value, { uri: 'https://x/y.pdf', mimeType: 'application/pdf' });
});

test('the file the final task frame replays is not shown twice', () => {
  const file = [{ uri: 'https://x/out.png', mimeType: 'image/png' }];
  const events = ended(
    [fileFrame(...file), { ...fileFrame(...file), view: 'task', state: 'completed' }, answer('here it is')],
    { settlement: settle('completed'), state: 'completed' },
  );
  assert.equal(events.filter((event) => event.type === 'CUSTOM').length, 1);
  // The artifact is output on its own, so the answer still opens a message.
  assert.equal(events.some((event) => event.type === 'TEXT_MESSAGE_CONTENT'), true);
});

test('a failed frame emits no file artifact', () => {
  const events = ended([{ ...fileFrame({ uri: 'u' }), state: 'failed', statusMessage: 'boom' }], {
    settlement: settle('failed', 'boom'),
    state: 'failed',
  });
  assert.equal(events.some((event) => event.type === 'CUSTOM'), false);
});

test('a web tool result becomes citation chips under the answer, once', () => {
  const search = { results: [{ url: 'https://go.dev/doc', title: 'Go documentation' }] };
  const events = ended(
    [
      toolCallFrame('s1', 'WebSearch', { q: 'go a2a' }),
      toolResultFrame('s1', 'WebSearch', search),
      // The same result artifact inside the final task frame must not double the list.
      toolResultFrame('s1', 'WebSearch', search),
      answer('the docs say X'),
    ],
    { settlement: settle('completed'), state: 'completed' },
  );
  const sources = events.filter((event) => event.type === 'CUSTOM' && event.name === 'fleet.dev/sources');
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0]?.value, { sources: [{ url: 'https://go.dev/doc', title: 'Go documentation' }] });
  // Under the answer, before the run closes.
  const order = types(events);
  assert.ok(order.indexOf('TEXT_MESSAGE_END') < order.indexOf('RUN_FINISHED'));
  assert.ok(order.indexOf('TEXT_MESSAGE_END') < order.lastIndexOf('CUSTOM'));
});

test('a run that did not complete reports no citations', () => {
  const events = ended([toolResultFrame('s1', 'WebFetch', { url: 'https://x.example/a' })], {
    settlement: settle('failed', 'boom'),
    state: 'failed',
  });
  assert.equal(events.some((event) => event.name === 'fleet.dev/sources'), false);
});

test('a structured result is spoken once, after the answer', () => {
  const structured = { value: { kind: 'table', props: { rows: [{ a: 1 }] } }, schemaSha256: 'sha256:1' };
  const events = ended(
    [answer('three rows'), { view: 'task', state: 'completed', structured }, { view: 'artifact-update', structured }],
    { settlement: settle('completed'), state: 'completed' },
  );
  const ui = events.filter((event) => event.type === 'CUSTOM' && event.name === 'fleet.dev/ui');
  assert.deepEqual(ui.map((event) => event.value), [{ kind: 'table', props: { rows: [{ a: 1 }] } }]);
  const order = types(events);
  assert.ok(order.indexOf('TEXT_MESSAGE_END') < order.lastIndexOf('CUSTOM'));
  assert.equal(order.at(-1), 'RUN_FINISHED');
});

test('a HITL request payload rides out on the interrupt metadata', () => {
  const hitl = { type: 'tool_approval_request', tools: [{ id: 'call-1', call_id: 'call-1', name: 'bash' }] };
  const events = ended(
    [{ view: 'status-update', state: 'input-required', statusMessage: 'approve this?', hitl }],
    { settlement: settle('awaiting_input'), state: 'input-required', taskId: 'task-9' },
  );
  const [interrupt] = interruptsOf(events.at(-1));
  assert.deepEqual((interrupt?.metadata as { hitl?: unknown }).hitl, hitl);
});

test('a completed turn is a success outcome carrying the A2A identity', () => {
  const events = ended([answer('yes')], {
    settlement: settle('completed'),
    state: 'completed',
    taskId: 'task-1',
    contextId: 'ctx-1',
  });
  const last = events.at(-1);
  assert.equal(last?.type, 'RUN_FINISHED');
  assert.equal(outcomeOf(last).type, 'success');
  assert.equal(resultOf(last).taskId, 'task-1');
  assert.equal(resultOf(last).contextId, 'ctx-1');
  assert.equal(resultOf(last).answered, true);
});

test('a completed turn with no parts is honest about it', () => {
  const events = ended([], {
    settlement: settle('completed', 'the agent completed the turn without producing any output'),
  });
  assert.equal(events.at(-1)?.type, 'RUN_FINISHED');
  assert.equal(resultOf(events.at(-1)).answered, false);
});

test('input-required is an interrupt, not a failure', () => {
  const events = ended([status('input-required', 'approve running rm?')], {
    settlement: settle('awaiting_input'),
    state: 'input-required',
    taskId: 'task-1',
  });
  const last = events.at(-1);
  assert.equal(last?.type, 'RUN_FINISHED');
  assert.equal(outcomeOf(last).type, 'interrupt');
  assert.equal(interruptsOf(last)[0]?.reason, 'input-required');
  assert.equal(interruptsOf(last)[0]?.id, 'task-1');
  // Nothing was streamed as text, so the question travels on the interrupt.
  assert.equal(interruptsOf(last)[0]?.message, 'approve running rm?');
  assert.equal(events.some((e) => e.type === 'TEXT_MESSAGE_START'), false);
});

test('auth-required keeps its own reason so the UI can ask for a sign-in', () => {
  const events = ended([], { settlement: settle('awaiting_input'), state: 'auth-required' });
  assert.equal(interruptsOf(events.at(-1))[0]?.reason, 'auth-required');
});

test('the pause question reaches the UI once: streamed as text, so the interrupt omits it', () => {
  const events = ended([answer('which file?', { state: 'input-required', view: 'status-update' })], {
    settlement: settle('awaiting_input'),
    state: 'input-required',
  });
  assert.equal(events.find((e) => e.type === 'TEXT_MESSAGE_CONTENT')?.delta, 'which file?');
  assert.equal(interruptsOf(events.at(-1))[0]?.message, undefined);
});

test("a failed turn reports the controller's own words on RUN_ERROR, not in the transcript", () => {
  const frame = { ...status('failed', 'OpenAI API error: 401 Unauthorized'), answer: 'OpenAI API error: 401 Unauthorized' };
  const events = ended([frame], {
    settlement: settle('failed', 'OpenAI API error: 401 Unauthorized'),
    state: 'failed',
  });
  const last = events.at(-1);
  assert.equal(last?.type, 'RUN_ERROR');
  assert.equal(last?.message, 'OpenAI API error: 401 Unauthorized');
  assert.equal(last?.code, 'failed');
  assert.equal(events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT'), false);
});

test('a platform fault settles as upstream_error and still ends the run', () => {
  const events = ended([status('failed', 'rate limit exceeded')], {
    settlement: settle('upstream_error', 'rate limit exceeded'),
    state: 'failed',
  });
  assert.equal(events.at(-1)?.type, 'RUN_ERROR');
  assert.equal(events.at(-1)?.code, 'upstream_error');
});

test('a cancelled turn is a finished run with the cancelled outcome', () => {
  const events = ended([answer('partial')], { settlement: settle('cancelled'), state: 'cancelled' });
  assert.equal(outcomeOf(events.at(-1)).type, 'cancelled');
  // Whatever was streamed is closed, or the client rejects the whole run.
  assert.equal(events.filter((e) => e.type === 'TEXT_MESSAGE_END').length, 1);
});

test('a client abort is cancelled too, and never RUN_ERROR', () => {
  const events = ended([], { settlement: settle('client_abort', 'the browser disconnected before the turn finished') });
  assert.equal(outcomeOf(events.at(-1)).type, 'cancelled');
});

test('a rejected task ends the run with its reason', () => {
  const events = ended([], { settlement: settle('rejected', 'input was not accepted'), state: 'rejected' });
  assert.equal(events.at(-1)?.type, 'RUN_ERROR');
  assert.equal(events.at(-1)?.code, 'rejected');
});

test('a stream that produced nothing is a run error, not an empty success', () => {
  const events = ended([], { settlement: settle('no_events', 'the agent stream ended without producing any events') });
  assert.deepEqual(types(events), ['RUN_STARTED', 'RUN_ERROR']);
});

test('fail() closes an open message before reporting the error', () => {
  const encoder = createTurnEncoder(IDENTITY);
  const events = [
    ...encoder.started(),
    ...encoder.frame(answer('half an answer')),
    ...encoder.fail('kagent stream failed (502)'),
  ] as Emit[];
  assert.deepEqual(types(events), [
    'RUN_STARTED',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'RUN_ERROR',
  ]);
  assert.equal(events.at(-1)?.message, 'kagent stream failed (502)');
  assert.equal(verifySequence(events), undefined);
});

test('nothing is emitted once the run is closed', () => {
  const encoder = createTurnEncoder(IDENTITY);
  encoder.started();
  encoder.frame(answer('first'));
  encoder.end({ settlement: settle('completed'), state: 'completed' });
  assert.deepEqual(encoder.frame(answer('late')), []);
  assert.deepEqual(encoder.end({ settlement: settle('failed', 'twice') }), []);
  assert.deepEqual(encoder.fail('also late'), []);
});
