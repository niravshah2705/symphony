'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const log = require('./logger');

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/** Capture what the logger would put on stdout; the file append is untouched. */
function capture(t, fn) {
  const lines = [];
  const original = console.log;
  t.after(() => { console.log = original; });
  console.log = (line) => lines.push(String(line));
  fn();
  return lines;
}

test('logger: text output stays a human-readable line when nothing is bound', (t) => {
  t.after(() => { delete process.env.LOG_FORMAT; });
  const [line] = capture(t, () => log.info('hello world'));
  assert.match(line, /^\[\d{4}-\d\d-\d\dT.*Z\] INFO  hello world$/);
});

test('logger: withContext labels the line with the run it belongs to', (t) => {
  t.after(() => { delete process.env.LOG_FORMAT; });
  const tlog = log.withContext({ organizationId: 'org-1', runId: 'run-9', traceparent: TP });
  const [line] = capture(t, () => tlog.warn('model rejected the request'));
  assert.match(line, /model rejected the request \{[^}]*\}$/);
  assert.match(line, /org=org-1/);
  assert.match(line, /run=run-9/);
  assert.match(line, new RegExp(`trace=${TRACE_ID}`));
});

test('logger: runWithContext reaches code that knows nothing about the run', (t) => {
  t.after(() => { delete process.env.LOG_FORMAT; });
  const lines = capture(t, () => log.runWithContext({ projectId: 'p-1', traceparent: TP }, () => {
    log.info('deep inside a harness');
  }));
  assert.match(lines[0], /project=p-1/);
  assert.match(lines[0], new RegExp(`trace=${TRACE_ID}`));
  // The binding must not leak out to the next, unrelated operation.
  const [outer] = capture(t, () => log.info('next request'));
  assert.doesNotMatch(outer, /project=p-1/);
});

test('logger: LOG_FORMAT=json emits one Cloud Logging-shaped record per line', (t) => {
  process.env.LOG_FORMAT = 'json';
  process.env.GOOGLE_CLOUD_PROJECT = 'fleet-prod';
  t.after(() => {
    delete process.env.LOG_FORMAT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });
  const tlog = log.withContext({ organizationId: 'org-1', traceparent: TP });
  const [line] = capture(t, () => tlog.error('egress failed', { upstream: 'openrouter', attempt: 2 }));
  const record = JSON.parse(line);
  assert.equal(record.severity, 'ERROR');
  assert.equal(record.message, 'egress failed');
  assert.equal(record.timestamp.slice(0, 4), String(new Date().getFullYear()));
  assert.equal(record.organizationId, 'org-1');
  assert.equal(record.traceId, TRACE_ID);
  // This is the field that makes Logs Explorer jump to the trace.
  assert.equal(record['logging.googleapis.com/trace'], `projects/fleet-prod/traces/${TRACE_ID}`);
  assert.deepEqual(record.meta, { upstream: 'openrouter', attempt: 2 });
});

test('logger: a credential in the meta payload stays masked in both formats', (t) => {
  const secret = { openrouterApiKey: 'sk-or-v1-secret', githubToken: 'ghp_secret', ok: 'visible' };
  process.env.LOG_FORMAT = 'json';
  t.after(() => { delete process.env.LOG_FORMAT; });
  const [jsonLine] = capture(t, () => log.warn('calling provider', secret));
  const record = JSON.parse(jsonLine);
  assert.equal(record.meta.openrouterApiKey, '••••');
  assert.equal(record.meta.githubToken, '••••');
  assert.equal(record.meta.ok, 'visible');
  assert.doesNotMatch(jsonLine, /sk-or-v1-secret|ghp_secret/);

  delete process.env.LOG_FORMAT;
  const [textLine] = capture(t, () => log.warn('calling provider', secret));
  assert.doesNotMatch(textLine, /sk-or-v1-secret|ghp_secret/);
});

test('logger: a fabricated or malformed trace id never becomes a trace link', (t) => {
  process.env.LOG_FORMAT = 'json';
  process.env.GOOGLE_CLOUD_PROJECT = 'fleet-prod';
  t.after(() => {
    delete process.env.LOG_FORMAT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });
  const [line] = capture(t, () => log.withContext({ traceId: 'not-a-trace-id', traceparent: 'junk' })
    .info('unattributable'));
  const record = JSON.parse(line);
  assert.equal(record.traceId, undefined);
  assert.equal(record['logging.googleapis.com/trace'], undefined);
});
