import test from 'node:test';
import assert from 'node:assert/strict';
import type { Event as AgUiEvent } from '@ag-ui/core';
import { pumpTurn, type Pump } from '../src/a2a/facade.ts';
import { createTurnEncoder } from '../src/agui/encode.ts';
import type { WireFrame } from '../src/a2a/translate.ts';
import type { SessionRow } from '../src/db/sessions.ts';

// What this proves is the seam the AG-UI leg is made of: the pump hands every
// frame it parses to the encoder, in arrival order, and the sequence that comes
// out is one the browser's client will accept. The database is deliberately not
// involved — the row id below exists nowhere, so the settle write matches zero
// rows or refuses to connect, and either way pumpTurn swallows it. That is itself
// one of the behaviours under test: a lost accounting write must not break the
// stream a human is watching.
const IDENTITY = { threadId: 'thread-1', runId: 'run-1' };
// A task object spells its id `id`; an update frame names the task it belongs to
// as `taskId`. Only the first two frames below are task views, so the fixture
// that most frames use is the second spelling.
const TASK = { taskId: 'task-9', contextId: 'ctx-9' };

function row(): SessionRow {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    kagent_session_id: null,
    kagent_task_id: null,
    status: 'running',
    meter_seconds: null,
  } as unknown as SessionRow;
}

// The controller writes `data: {...}\n\n` per frame; chunk boundaries are the
// transport's business, so a test may cut a frame in half.
const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function sseResponse(blocks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(new TextEncoder().encode(block));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function run(blocks: string[], over: Partial<SessionRow> = {}) {
  const frames: WireFrame[] = [];
  const relayed: string[] = [];
  const logs: string[] = [];
  const encoder = createTurnEncoder(IDENTITY);
  const events: AgUiEvent[] = encoder.started();
  let last: { state?: string; taskId?: string; contextId?: string } = {};

  const pump: Pump = {
    upstream: sseResponse(blocks),
    session: { ...row(), ...over },
    // thoughts: false and no write — this is the AG-UI leg, which re-speaks the
    // turn rather than forwarding kagent's bytes.
    thoughts: false,
    onFrame: (parsed): void => {
      frames.push(parsed);
      if (parsed.state) last.state = parsed.state;
      if (parsed.taskId) last.taskId = parsed.taskId;
      if (parsed.contextId) last.contextId = parsed.contextId;
      events.push(...encoder.frame(parsed));
    },
    log: (message) => logs.push(message),
  };

  const settlement = await pumpTurn(pump);
  events.push(...encoder.end({ settlement, ...last }));
  return { frames, relayed, logs, events, settlement, types: () => events.map((event) => event.type) };
}

test('every parsed frame reaches the sink, split chunks and all', async () => {
  const whole = frame({ artifactUpdate: { ...TASK, artifact: { parts: [{ text: 'half ' }, { text: 'done' }] }, append: true } });
  const blocks = [
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_WORKING' } } }).slice(0, 40),
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_WORKING' } } }).slice(40),
    whole,
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_COMPLETED' } } }),
  ];
  const { frames, settlement, types, events } = await run(blocks);
  assert.equal(frames.length, 3, 'the frame split across two chunks is still one frame');
  assert.deepEqual(frames.map((f) => f.state), ['working', undefined, 'completed']);
  assert.equal(frames[1]?.answer, 'half done', 'both parts of one artifact are one answer');
  assert.equal(settlement.outcome, 'completed');
  assert.deepEqual(types(), [
    'RUN_STARTED',
    // The WORKING frame carries no text, so it emits nothing.
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'RUN_FINISHED',
  ]);
  // RUN_STARTED names the thread and run the client sent, or it matches no run.
  const started = events[0] as { threadId?: string; runId?: string };
  assert.deepEqual([started.threadId, started.runId], ['thread-1', 'run-1']);
});

test('the task and context handles the wire revealed are what the run is closed with', async () => {
  const blocks = [
    frame({ artifactUpdate: { ...TASK, artifact: { parts: [{ text: 'output' }] } } }),
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_COMPLETED' } } }),
  ];
  const { events } = await run(blocks);
  const finished = events[events.length - 1] as { result?: Record<string, unknown> };
  assert.deepEqual(finished.result, { contextId: 'ctx-9', outcome: 'completed', answered: true, taskId: 'task-9' });
});

test('a conversation the pump learned mid-turn is bound once, and the relay stays verbatim', async () => {
  // The A2A leg is the one that forwards bytes; run it alongside to prove adding
  // the AG-UI sink did not change what a browser on /api/a2a receives.
  const blocks = [
    frame({ artifactUpdate: { ...TASK, artifact: { parts: [{ text: 'plain output' }] } } }),
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_COMPLETED' } } }),
  ];
  const relayed: string[] = [];
  const settlement = await pumpTurn({
    upstream: sseResponse(blocks),
    session: row(),
    thoughts: true,
    write: (chunk) => relayed.push(chunk),
  });
  assert.equal(settlement.outcome, 'completed');
  assert.equal(relayed.join(''), blocks.join(''), 'the A2A leg forwards bytes, not meanings');
});

test('a pause says the question once, as text, and the interrupt does not repeat it', async () => {
  const blocks = [
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [{ text: 'run the migration?' }] } } } }),
  ];
  const { settlement, types, events } = await run(blocks);
  assert.equal(settlement.outcome, 'awaiting_input');
  // The pause is a finish, never an error, and the question is ordinary
  // assistant text: it belongs in the transcript and stays there when the run is
  // resumed. The interrupt is the gate, not a second copy of the sentence.
  assert.deepEqual(types(), ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  const finished = events[4] as { outcome?: { type: string; interrupts?: Record<string, unknown>[] } };
  assert.equal(finished.outcome?.type, 'interrupt');
  assert.deepEqual(finished.outcome?.interrupts, [
    { id: 'task-9', reason: 'input-required' },
  ], 'the interrupt id is the task a resume must name');
});

test('a pause that asks nothing in words the UI can read still names why it stopped', async () => {
  const blocks = [frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_AUTH_REQUIRED' } } })];
  const { settlement, types, events } = await run(blocks);
  assert.equal(settlement.outcome, 'awaiting_input');
  assert.deepEqual(types(), ['RUN_STARTED', 'RUN_FINISHED']);
  const finished = events[1] as { outcome?: { interrupts?: Record<string, unknown>[] } };
  assert.deepEqual(finished.outcome?.interrupts, [{ id: 'task-9', reason: 'auth-required' }]);
});

test('a failure reports the agent’s own words, once', async () => {
  const blocks = [
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_FAILED', message: { parts: [{ text: 'the test harness could not parse this' }] } } } }),
  ];
  const { settlement, types } = await run(blocks);
  assert.equal(settlement.outcome, 'failed');
  assert.equal(settlement.reason, 'the test harness could not parse this');
  // No TEXT_MESSAGE_* at all: the reason belongs on RUN_ERROR, not in the transcript.
  assert.deepEqual(types(), ['RUN_STARTED', 'RUN_ERROR']);
});

test('a broken credential is written off, and the run says so as an error', async () => {
  const blocks = [
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_FAILED', message: { parts: [{ text: 'OpenAI API error: 401 Unauthorized' }] } } } }),
  ];
  const { settlement, events } = await run(blocks);
  assert.equal(settlement.outcome, 'upstream_error');
  const error = events[1] as { code?: string };
  assert.equal(error.code, 'upstream_error', 'the code is what the UI branches on');
});

test('a thought streams as reasoning and closes before the answer opens', async () => {
  const blocks = [
    frame({ artifactUpdate: { ...TASK, artifact: { parts: [{ text: 'checking the diff', metadata: { 'kagent.dev/a2a/thought': true } }] } } }),
    frame({ artifactUpdate: { ...TASK, artifact: { parts: [{ text: 'the diff is safe' }] } } }),
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_COMPLETED' } } }),
  ];
  const { types } = await run(blocks);
  assert.deepEqual(types(), [
    'RUN_STARTED',
    'REASONING_START',
    'REASONING_MESSAGE_START',
    'REASONING_MESSAGE_CONTENT',
    'REASONING_MESSAGE_END',
    'REASONING_END',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'RUN_FINISHED',
  ]);
});

test('tool data parts become the AG-UI tool sequence, once across the final replay', async () => {
  const call = { data: { id: 'tool-1', name: 'bash', args: { cmd: 'ls' } }, metadata: { 'kagent.dev/a2a/part-type': 'function_call' } };
  const result = { data: { id: 'tool-1', name: 'bash', response: { exit: 0 } }, metadata: { 'kagent.dev/a2a/part-type': 'function_response' } };
  const blocks = [
    frame({ artifactUpdate: { ...TASK, artifact: { parts: [call] } } }),
    frame({ artifactUpdate: { ...TASK, artifact: { parts: [result] } } }),
    // The completed task replays every artifact of the turn; the tool card must
    // not appear twice (fleet-local/docs/TROUBLESHOOTING.md calls this quirk out).
    frame({ task: { ...TASK, id: 'task-9', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [call, result] }] } }),
  ];
  const { events, settlement } = await run(blocks);
  assert.equal(settlement.outcome, 'completed');
  assert.deepEqual(
    events.filter((event) => String(event.type).startsWith('TOOL_CALL_')).map((event) => event.type),
    ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT'],
  );
});

test('an agent-produced file part reaches the browser as a CUSTOM artifact, once', async () => {
  const png = { file: { bytes: 'aGVsbG8=', mimeType: 'image/png', name: 'shot.png' } };
  const blocks = [
    frame({ artifactUpdate: { ...TASK, artifact: { parts: [png] } } }),
    frame({ task: { ...TASK, id: 'task-9', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [png] }] } }),
  ];
  const { events, settlement } = await run(blocks);
  assert.equal(settlement.outcome, 'completed');
  const custom = events.filter((event) => event.type === 'CUSTOM');
  assert.equal(custom.length, 1);
  assert.equal(custom[0]?.name, 'fleet.dev/file');
  assert.equal((custom[0]?.value as { dataUri?: string }).dataUri, 'data:image/png;base64,aGVsbG8=');
});

test('an rpc error that never reached a terminal state is still a reason', async () => {
  const blocks = [frame({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'the agent is not ready' } })];
  const { settlement, types } = await run(blocks);
  assert.equal(settlement.outcome, 'failed');
  assert.match(String(settlement.reason), /the agent is not ready/);
  assert.deepEqual(types(), ['RUN_STARTED', 'RUN_ERROR']);
});

test('a browser abort cancels the live task upstream', async () => {
  const blocks = [
    frame({ artifactUpdate: { ...TASK, artifact: { parts: [{ text: 'streaming away' }] } } }),
    frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_WORKING' } } }),
  ];
  const cancelled: string[] = [];
  const settlement = await pumpTurn({
    upstream: sseResponse(blocks),
    session: row(),
    thoughts: false,
    aborted: () => true,
    onCancel: async (taskId) => {
      cancelled.push(taskId);
    },
  });
  assert.equal(settlement.outcome, 'client_abort');
  assert.deepEqual(cancelled, ['task-9'], 'the task the wire named is the one cancelled');
});

test('an abort after a terminal state does not cancel', async () => {
  const blocks = [frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_COMPLETED' } } })];
  const cancelled: string[] = [];
  const settlement = await pumpTurn({
    upstream: sseResponse(blocks),
    session: row(),
    thoughts: false,
    aborted: () => true,
    onCancel: async (taskId) => {
      cancelled.push(taskId);
    },
  });
  assert.equal(settlement.outcome, 'completed', 'a run that finished is not an abort');
  assert.deepEqual(cancelled, []);
});

test('a cancel the upstream refuses settles the turn anyway', async () => {
  const blocks = [frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_WORKING' } } })];
  const logs: string[] = [];
  const settlement = await pumpTurn({
    upstream: sseResponse(blocks),
    session: row(),
    thoughts: false,
    aborted: () => true,
    onCancel: async () => {
      throw new Error('task not found');
    },
    log: (message) => logs.push(message),
  });
  assert.equal(settlement.outcome, 'client_abort');
  assert.ok(logs.some((line) => line.includes('failed to cancel aborted task')), 'the refusal is logged, not thrown');
});

test('no frames at all is a refusal the client is told about', async () => {
  const { settlement, types } = await run([]);
  assert.equal(settlement.outcome, 'no_events');
  assert.deepEqual(types(), ['RUN_STARTED', 'RUN_ERROR']);
});

test('a stream that ends mid-turn, before any terminal state, is a platform fault', async () => {
  const blocks = [frame({ statusUpdate: { ...TASK, status: { state: 'TASK_STATE_WORKING' } } })];
  const { settlement, types } = await run(blocks);
  assert.equal(settlement.outcome, 'upstream_error');
  assert.deepEqual(types(), ['RUN_STARTED', 'RUN_ERROR']);
});
