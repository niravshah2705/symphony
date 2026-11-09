'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRACEPARENT_HEADER, cleanTraceparent, traceIdOf, traceparentFromEnv,
} = require('./traceparent');

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

test('traceparent: header name is the W3C one, not a fleet-proprietary alias', () => {
  assert.equal(TRACEPARENT_HEADER, 'traceparent');
});

test('traceparent: accepts a well-formed version-00 value', () => {
  assert.equal(cleanTraceparent(VALID), VALID);
  // Surrounding whitespace and uppercase hex are both legal on the wire.
  assert.equal(cleanTraceparent(`  ${VALID.toUpperCase()} `), VALID);
  // The sampled flag is free to be anything two hex chars.
  assert.equal(cleanTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00'), VALID.replace('-01', '-00'));
});

test('traceparent: rejects every value that could not be continued', () => {
  for (const value of [
    '', ' ', null, undefined, 42, {}, [],
    'garbage',
    VALID.slice(0, -1),
    `${VALID}-extra`,
    // All-zero ids are the spec's invalid values, not a trace.
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
    // A version we cannot parse must not be re-serialized as if we could.
    '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    // Non-hex, control characters and CRLF never survive into a header value.
    '00-zzzz2f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736\n-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\r\nx: 1',
  ]) {
    assert.equal(cleanTraceparent(value), '', `must reject ${JSON.stringify(value)}`);
  }
});

test('traceparent: the trace id is the field a log line or usage row is joined on', () => {
  assert.equal(traceIdOf(VALID), '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(traceIdOf('nonsense'), '');
  assert.equal(traceIdOf(undefined), '');
});

test('traceparent: a job reads its inbound value from the environment', () => {
  assert.equal(traceparentFromEnv({ TRACEPARENT_INBOUND: VALID }), VALID);
  // A bare TRACEPARENT is what an OTel auto-instrumentation would set.
  assert.equal(traceparentFromEnv({ TRACEPARENT: VALID }), VALID);
  assert.equal(traceparentFromEnv({ TRACEPARENT_INBOUND: 'junk', TRACEPARENT: VALID }), VALID);
  assert.equal(traceparentFromEnv({}), '');
  assert.equal(traceparentFromEnv({ TRACEPARENT_INBOUND: 'junk' }), '');
});
