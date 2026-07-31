'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRetryableStreamError, runWithRetry, streamWithRetry } = require('./llm-retry');

/* ----------------------- isRetryableStreamError ------------------------ */

test('an OpenAI in-stream error (APIError with no status) is retryable', () => {
  // This is the exact shape thrown from openai/core/streaming.js when the SSE
  // body carries an `error` event mid-generation — the gap SDK retries miss.
  const err = new Error('An error occurred while processing your request.');
  err.name = 'APIError';
  assert.equal(isRetryableStreamError(err), true);
});

test('transient HTTP statuses (429, 500, 503, 529) are retryable', () => {
  for (const status of [429, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryableStreamError({ status }), true, `status ${status}`);
  }
});

test('deterministic client errors (400, 401, 404) are NOT retryable', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const err = new Error('nope');
    err.name = 'APIError';
    err.status = status;
    assert.equal(isRetryableStreamError(err), false, `status ${status}`);
  }
});

test('dropped-connection error codes are retryable', () => {
  assert.equal(isRetryableStreamError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableStreamError({ cause: { code: 'UND_ERR_SOCKET' } }), true);
});

test('an ordinary error with no signal is not retryable', () => {
  assert.equal(isRetryableStreamError(new Error('boom')), false);
  assert.equal(isRetryableStreamError(null), false);
});

/* ------------------------------ runWithRetry --------------------------- */

function apiStreamError() {
  const err = new Error('An error occurred while processing your request.');
  err.name = 'APIError';
  return err;
}

test('runWithRetry returns the first success without retrying', async () => {
  let calls = 0;
  const out = await runWithRetry(async () => { calls += 1; return 'ok'; }, 1);
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('runWithRetry retries once then succeeds (retries=1)', async () => {
  let calls = 0;
  const onRetry = [];
  const out = await runWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw apiStreamError();
    return 'recovered';
  }, 1, (err, attempt) => onRetry.push(attempt));
  assert.equal(out, 'recovered');
  assert.equal(calls, 2);
  assert.deepEqual(onRetry, [1]);
});

test('runWithRetry gives up after exhausting retries and rethrows', async () => {
  let calls = 0;
  await assert.rejects(
    () => runWithRetry(async () => { calls += 1; throw apiStreamError(); }, 2),
    /An error occurred/
  );
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test('runWithRetry does not retry a non-retryable error', async () => {
  let calls = 0;
  const notRetryable = new Error('bad request');
  notRetryable.name = 'APIError';
  notRetryable.status = 400;
  await assert.rejects(
    () => runWithRetry(async () => { calls += 1; throw notRetryable; }, 3),
    /bad request/
  );
  assert.equal(calls, 1);
});

test('runWithRetry with 0 retries never retries', async () => {
  let calls = 0;
  await assert.rejects(() => runWithRetry(async () => { calls += 1; throw apiStreamError(); }, 0));
  assert.equal(calls, 1);
});

/* ---------------------------- streamWithRetry -------------------------- */

async function* fromArray(items) {
  for (const item of items) yield item;
}

test('streamWithRetry passes chunks through on success', async () => {
  const out = [];
  for await (const chunk of streamWithRetry(() => fromArray([1, 2, 3]), 1)) out.push(chunk);
  assert.deepEqual(out, [1, 2, 3]);
});

test('streamWithRetry retries when the stream fails BEFORE the first chunk', async () => {
  let attempts = 0;
  const makeStream = () => {
    attempts += 1;
    return (async function* () {
      if (attempts === 1) throw apiStreamError();
      yield 'a';
      yield 'b';
    })();
  };
  const out = [];
  for await (const chunk of streamWithRetry(makeStream, 1)) out.push(chunk);
  assert.deepEqual(out, ['a', 'b']);
  assert.equal(attempts, 2);
});

test('streamWithRetry does NOT retry once a chunk has been yielded (would duplicate output)', async () => {
  let attempts = 0;
  const makeStream = () => {
    attempts += 1;
    return (async function* () {
      yield 'partial';
      throw apiStreamError();
    })();
  };
  const out = [];
  await assert.rejects(async () => {
    for await (const chunk of streamWithRetry(makeStream, 3)) out.push(chunk);
  }, /An error occurred/);
  assert.deepEqual(out, ['partial']);
  assert.equal(attempts, 1);
});
