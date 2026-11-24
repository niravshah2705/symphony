import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A2ARequestError,
  assertTaskOwnership,
  classifyState,
  classifyStreamEnd,
  isOutcome,
  isPlatformFault,
  normalizeState,
  outcomeForState,
  settlementPolicy,
  toA2AErrorBody,
  truncate,
} from '../src/a2a/contract.ts';

test('a paused task is NOT terminal — the highest-value regression in this file', () => {
  // Treating INPUT_REQUIRED as terminal is what made approval and ask_user
  // impossible: the row closed, the meter stopped, and the resume had nothing
  // to re-arm.
  for (const raw of ['TASK_STATE_INPUT_REQUIRED', 'input_required', 'input-required']) {
    assert.equal(classifyState(raw), 'paused', raw);
    assert.equal(outcomeForState(raw), 'awaiting_input');
  }
  for (const raw of ['TASK_STATE_AUTH_REQUIRED', 'auth_required']) {
    assert.equal(classifyState(raw), 'paused', raw);
    assert.equal(outcomeForState(raw), 'awaiting_input');
  }
});

test('the three wire spellings of one state classify identically', () => {
  for (const raw of ['TASK_STATE_COMPLETED', 'completed', 'COMPLETED']) {
    assert.equal(normalizeState(raw), 'completed');
    assert.equal(classifyState(raw), 'terminal');
    assert.equal(outcomeForState(raw), 'completed');
  }
  for (const raw of ['TASK_STATE_FAILED', 'failed']) {
    assert.equal(classifyState(raw), 'terminal');
    assert.equal(outcomeForState(raw), 'failed');
  }
  assert.equal(classifyState('TASK_STATE_WORKING'), 'running');
  assert.equal(classifyState('TASK_STATE_SUBMITTED'), 'running');
  assert.equal(classifyState(undefined), 'running');
  assert.equal(classifyState('TASK_STATE_UNSPECIFIED'), 'running');
  assert.equal(normalizeState('  '), undefined);
});

test('the proto CANCELED spelling and the old two-L spelling are one outcome', () => {
  // The BFF's own TERMINAL set spelled it CANCELLED while the proto says
  // CANCELED, so a cancelled run matched nothing: never closed, never metered.
  assert.equal(normalizeState('TASK_STATE_CANCELED'), 'cancelled');
  assert.equal(normalizeState('TASK_STATE_CANCELLED'), 'cancelled');
  assert.equal(outcomeForState('TASK_STATE_CANCELED'), 'cancelled');
  assert.equal(outcomeForState('TASK_STATE_REJECTED'), 'rejected');
});

test('classifyStreamEnd trusts the wire state over anything inferred after it', () => {
  // A dead provider key arrives as TASK_STATE_FAILED with the reason in
  // status.message. It is the platform that broke, so it must not be billed —
  // and the UI must still get that string, not "(no output)".
  const platform = classifyStreamEnd({
    state: 'failed',
    failureMessage: 'Error 401: user_message: Invalid API key #1005',
    framesSeen: 3,
  });
  assert.equal(platform.outcome, 'upstream_error');
  assert.equal(platform.reason, 'Error 401: user_message: Invalid API key #1005');
  assert.equal(settlementPolicy('closed', platform.outcome), 'skip');

  // The agent's own failure is different: it ran, so the compute is billed.
  const agent = classifyStreamEnd({ state: 'failed', failureMessage: 'sandbox exited with code 1', framesSeen: 3 });
  assert.equal(agent.outcome, 'failed');
  assert.equal(agent.reason, 'sandbox exited with code 1');
  assert.equal(settlementPolicy('closed', agent.outcome), 'meter');

  // The browser can go away while the run finishes; the run still happened.
  assert.equal(classifyStreamEnd({ state: 'completed', aborted: true, framesSeen: 5 }).outcome, 'completed');
  assert.equal(classifyStreamEnd({ state: 'input-required', framesSeen: 2 }).outcome, 'awaiting_input');

  // An RPC error inside a 200 is the agent's verdict, not a transport accident.
  const rpc = classifyStreamEnd({ rpcError: 'task not found', framesSeen: 1 });
  assert.equal(rpc.outcome, 'failed');
  assert.equal(rpc.reason, 'task not found');

  assert.equal(classifyStreamEnd({ httpStatus: 502, upstreamBody: 'BG-01 upstream timeout' }).outcome, 'upstream_error');
  assert.equal(classifyStreamEnd({ aborted: true, framesSeen: 4 }).outcome, 'client_abort');
  assert.equal(classifyStreamEnd({ readError: 'socket hang up', framesSeen: 4 }).outcome, 'upstream_error');
  // The old dead end: the stream closed having said nothing at all.
  const nothing = classifyStreamEnd({ framesSeen: 0 });
  assert.equal(nothing.outcome, 'no_events');
  assert.match(nothing.reason ?? '', /without producing any events/);
  // Frames but never a terminal state: still an unfinished platform story.
  const half = classifyStreamEnd({ state: 'working', framesSeen: 9 });
  assert.equal(half.outcome, 'upstream_error');
  assert.match(half.reason ?? '', /before the task reached a terminal state/);
});

test('an upstream http failure outranks a stale terminal state', () => {
  const s = classifyStreamEnd({ httpStatus: 503, upstreamBody: 'no healthy upstream', state: 'completed' });
  assert.equal(s.outcome, 'upstream_error');
});

test('a completed turn with no output says so, without changing the outcome', () => {
  // The mock worker settles a turn with no artifacts at all: an empty bubble the
  // user cannot explain. The reason records it; the compute still gets billed.
  const silent = classifyStreamEnd({ state: 'TASK_STATE_COMPLETED', framesSeen: 4, answered: false });
  assert.equal(silent.outcome, 'completed');
  assert.match(silent.reason ?? '', /without producing any output/);
  assert.equal(settlementPolicy('closed', silent.outcome), 'meter');

  assert.equal(classifyStreamEnd({ state: 'completed', framesSeen: 5, answered: true }).reason, null);
  // We only claim silence when we actually looked at the parts.
  assert.equal(classifyStreamEnd({ state: 'completed', framesSeen: 2 }).reason, null);
  // A paused task's status.message IS the question, never a missing answer.
  assert.equal(classifyStreamEnd({ state: 'input-required', framesSeen: 2, answered: false }).reason, null);
});

test('platform faults are recognised narrowly', () => {
  for (const reason of [
    'OpenAI API error: 401 Unauthorized',
    'llm error response (code STREAM_ERROR): "OpenAI API error: 401 Unauthorized"',
    'Error 401: user_message: Invalid API key #1005',
    'no healthy upstream',
    '429 Too Many Requests',
    'insufficient quota',
    // A retired model id, in both spellings the gateway actually uses (proved
    // live with the rotated key): the provider's words, and kagent's envelope.
    'anthropic/claude-sonnet-4 is no longer available on OpenRouter: no provider serves this model anymore',
    'llm error response (code STREAM_ERROR): "OpenAI API error: 404 Not Found"',
    'OpenAI API error: 404 Not Found',
    // A run the controller refused to start.
    'input was not accepted; retry after the session becomes available',
  ]) {
    assert.equal(isPlatformFault(reason), true, `should be a platform fault: ${reason}`);
    assert.equal(classifyStreamEnd({ state: 'failed', failureMessage: reason }).outcome, 'upstream_error');
  }
  for (const reason of [
    'the agent reached its step limit',
    'sandbox exited with code 1',
    'no such tool: filesystem_read',
    // The agent's OWN 404, from a tool it chose to call, is not the platform's
    // fault: that compute happened and the model really was contacted.
    'web_fetch returned HTTP 404 for https://example.invalid/missing',
    'file not found: src/missing.ts',
    undefined,
    '',
  ]) {
    assert.equal(isPlatformFault(reason), false, `should stay the agent's own failure: ${String(reason)}`);
  }
  // Unknown reasons are billed, never silently written off.
  assert.equal(settlementPolicy('closed', classifyStreamEnd({ state: 'failed', failureMessage: 'tool call rejected' }).outcome), 'meter');
});

test('reasons reaching a human are truncated, bodies are not', () => {
  const long = 'x'.repeat(2000);
  assert.equal(truncate(long).length, 501);
  assert.equal(truncate('short'), 'short');
});

test('settlement policy: depends on the failure type', () => {
  assert.equal(settlementPolicy('closed', 'completed'), 'meter');
  assert.equal(settlementPolicy('closed', 'failed'), 'meter'); // the agent ran and answered wrong
  assert.equal(settlementPolicy('closed', 'cancelled'), 'meter');
  assert.equal(settlementPolicy('closed', 'client_abort'), 'meter');
  assert.equal(settlementPolicy('closed', 'upstream_error'), 'skip'); // the platform broke it
  assert.equal(settlementPolicy('closed', 'no_events'), 'skip');
  assert.equal(settlementPolicy('awaiting_input', 'awaiting_input'), 'meter');
  assert.equal(settlementPolicy('running', 'completed'), 'skip'); // not settled yet
  // A hand-edited or legacy row can never invent an outcome that bills.
  assert.equal(settlementPolicy('closed', null), 'meter');
  assert.equal(settlementPolicy('closed', 'nonsense'), 'meter');
  assert.equal(settlementPolicy('failed_status', 'completed'), 'skip');
});

test('isOutcome guards the text column on the way back in', () => {
  assert.equal(isOutcome('no_events'), true);
  assert.equal(isOutcome('completed '), false);
  assert.equal(isOutcome(null), false);
  assert.equal(isOutcome('drop_sessions'), false);
});

test('errors are shaped the way the A2A client reads them', () => {
  // The refusal a disabled organisation gets (lifecycle.refuse) has to survive the
  // envelope: the SPA keys its human sentence off this reason, and a body that
  // loses it renders as "A2A request failed: 409".
  const suspended = toA2AErrorBody(409, 'organisation is disabled — agent calls are turned off', {
    reason: 'org_disabled',
  });
  assert.equal(suspended.error.status, 'FAILED_PRECONDITION');
  assert.equal(suspended.error.code, 409);
  assert.deepEqual(suspended.error.details, [
    {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'org_disabled',
      domain: 'fleet.dev',
    },
  ]);
  // A deleted org is not "disabled": the row is gone, and that is a 404.
  assert.equal(toA2AErrorBody(404, 'organisation not found', { reason: 'org_not_found' }).error.status, 'NOT_FOUND');

  const body = toA2AErrorBody(409, 'project onboarding incomplete', { reason: 'onboarding_incomplete' });
  assert.equal(body.error.status, 'FAILED_PRECONDITION');
  assert.equal(body.error.code, 409);
  assert.equal(body.error.message, 'project onboarding incomplete');
  assert.deepEqual(body.error.details, [
    {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'onboarding_incomplete',
      domain: 'fleet.dev',
    },
  ]);

  assert.equal(toA2AErrorBody(401, 'x').error.status, 'UNAUTHENTICATED');
  assert.equal(toA2AErrorBody(403, 'x').error.status, 'PERMISSION_DENIED');
  assert.equal(toA2AErrorBody(404, 'x').error.status, 'NOT_FOUND');
  assert.equal(toA2AErrorBody(400, 'x').error.status, 'INVALID_ARGUMENT');
  assert.equal(toA2AErrorBody(502, 'x').error.status, 'UNAVAILABLE');
  assert.equal(toA2AErrorBody(500, 'x').error.status, 'INTERNAL');
  assert.equal(toA2AErrorBody(418, 'x').error.status, 'INVALID_ARGUMENT');
  assert.equal(toA2AErrorBody(400, 'x').error.details, undefined);
});

test('A2ARequestError carries its status and info through the error handler', () => {
  const err = new A2ARequestError(404, 'unknown conversation', { reason: 'unknown_conversation' });
  assert.equal(err.statusCode, 404);
  assert.equal(err.info?.reason, 'unknown_conversation');
  assert.equal(err.name, 'A2ARequestError');
  assert.ok(err instanceof Error);
});

test('task ownership is checked against our own contexts, never the client', () => {
  const contexts = ['ctx-mine-a', 'ctx-mine-b'];
  assert.equal(assertTaskOwnership({ id: 't1', contextId: 'ctx-mine-a' }, contexts), undefined);
  assert.equal(assertTaskOwnership({ id: 't1', contextId: 'ctx-theirs' }, contexts), 'task does not belong to this project');
  assert.equal(assertTaskOwnership({ id: 't1' }, contexts), 'task carries no context id');
  assert.equal(assertTaskOwnership(undefined, contexts), 'task not found');
});
