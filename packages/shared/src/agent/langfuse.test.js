'use strict';

/**
 * Langfuse module: one trace per run, error surfacing, the privacy gate, and the
 * fail-open export budget. The OTLP exporter is replaced by a recording seam, so
 * nothing here dials the network.
 */

process.env.LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';
process.env.LANGFUSE_PROJECT_ID = 'proj-test';
process.env.LANGFUSE_ENVIRONMENT = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');

const langfuse = require('./langfuse');

const KEYS = { langfusePublicKey: 'pk-lf-test', langfuseSecretKey: 'sk-lf-test', langfuseTracing: true };

const collected = new InMemorySpanExporter();
const exporter = {
  delayMs: 0,
  // A positive delay outlasts the flush budget without leaving a 30s export
  // timeout pending at process exit.
  export(batch, resultCallback) {
    if (exporter.delayMs > 0) {
      setTimeout(() => collected.export(batch, resultCallback), exporter.delayMs);
      return;
    }
    collected.export(batch, resultCallback);
  },
  forceFlush: () => collected.forceFlush(),
  shutdown: () => collected.shutdown(),
};

function spans() {
  const finished = collected.getFinishedSpans();
  collected.reset();
  return finished;
}

function byName(spans_, name) {
  return spans_.find((span) => span.name === name);
}

// Boot the process-global transport once, against the in-memory collector.
langfuse.configureLangfuse(KEYS, { exporter, flushTimeoutMs: 40 });

test('a successful run exports one root span plus an llm generation child', async () => {
  // Arrange
  const result = { text: 'done', usage: { input: 3, output: 5 }, costUsd: 0.02 };

  // Act
  const observed = await langfuse.traceAgentRun(
    {
      name: 'agent-runtime:deepagent',
      traceName: 'planning',
      input: 'build it',
      metadata: { harness: 'deepagent', pattern: 'sequential' },
      tags: ['org:acme', 'harness:deepagent', 'org:acme'],
      userId: 'user-1',
      sessionId: 'session-1',
      model: 'gpt-5',
      llm: { provider: 'openrouter', model: 'gpt-5' },
      describe: (value) => ({
        output: { text: value.text },
        metadata: { usage_total_tokens: 8 },
        usageDetails: { input: 3, output: 5 },
        costDetails: { total: 0.02 },
      }),
    },
    async () => result
  );

  // Assert
  assert.equal(observed, result);
  const emitted = spans();
  const root = byName(emitted, 'agent-runtime:deepagent');
  const generation = byName(emitted, 'llm');
  assert.ok(root, 'root observation missing');
  assert.ok(generation, 'generation observation missing');
  assert.equal(root.attributes['langfuse.observation.type'], 'span');
  assert.equal(root.attributes['langfuse.observation.input'], 'build it');
  assert.deepEqual(JSON.parse(root.attributes['langfuse.observation.output']), { text: 'done' });
  assert.equal(root.attributes['langfuse.observation.metadata.harness'], '"deepagent"');
  assert.equal(root.attributes['langfuse.observation.metadata.usage_total_tokens'], '8');
  assert.deepEqual(root.attributes['langfuse.trace.tags'], ['org:acme', 'harness:deepagent']);
  assert.equal(root.attributes['user.id'], 'user-1');
  assert.equal(root.attributes['session.id'], 'session-1');
  assert.equal(root.attributes['langfuse.trace.name'], 'planning');
  assert.equal(root.attributes['langfuse.environment'], 'test');
  assert.equal(generation.attributes['langfuse.observation.type'], 'generation');
  assert.equal(generation.attributes['langfuse.observation.model.name'], 'gpt-5');
  assert.deepEqual(JSON.parse(generation.attributes['langfuse.observation.usage_details']), { input: 3, output: 5 });
  assert.equal(generation.parentSpanContext.spanId, root.spanContext().spanId);
  assert.equal(generation.spanContext().traceId, root.spanContext().traceId);
});

test('the trace id is handed to the caller before the run executes', async () => {
  // Arrange
  const seen = [];

  // Act
  await langfuse.traceAgentRun(
    { name: 'agent-runtime:codex-sdk', llm: {}, onTraceId: (id) => seen.push(id) },
    async () => 'ok'
  );

  // Assert
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^[0-9a-f]{32}$/);
  const emitted = spans();
  assert.equal(byName(emitted, 'agent-runtime:codex-sdk').spanContext().traceId, seen[0]);
});

test('a failing run is marked ERROR, keeps its metadata, and rethrows', async () => {
  // Arrange / Act
  const failure = new Error('codex execution failed: stream dropped');
  await assert.rejects(
    langfuse.traceAgentRun(
      {
        name: 'agent-runtime:codex-sdk',
        input: 'ship it',
        metadata: { harness: 'codex-sdk' },
        model: 'gpt-5',
        llm: {},
        describe: () => ({ metadata: { usage_available: false } }),
      },
      async () => {
        throw failure;
      }
    ),
    (error) => error === failure
  );

  // Assert
  const emitted = spans();
  const root = byName(emitted, 'agent-runtime:codex-sdk');
  const generation = byName(emitted, 'llm');
  assert.equal(root.attributes['langfuse.observation.level'], 'ERROR');
  assert.equal(root.attributes['langfuse.observation.status_message'], 'codex execution failed: stream dropped');
  assert.deepEqual(JSON.parse(root.attributes['langfuse.observation.output']), {
    error: 'codex execution failed: stream dropped',
  });
  assert.equal(root.attributes['langfuse.observation.metadata.usage_available'], 'false');
  assert.equal(generation.attributes['langfuse.observation.level'], 'ERROR');
});

test('no trace is exported while the organization pref is off', async () => {
  // Arrange
  assert.equal(langfuse.configureLangfuse({ ...KEYS, langfuseTracing: false }), false);
  assert.equal(langfuse.langfuseEnabled(), false);

  // Act
  const observed = await langfuse.traceAgentRun({ name: 'agent-runtime:deepagent', llm: {} }, async () => 'value');

  // Assert
  assert.equal(observed, 'value');
  assert.deepEqual(spans(), []);
  langfuse.configureLangfuse(KEYS, { exporter });
});

test('a string "false" pref off-switches tracing too', () => {
  // Arrange / Act / Assert — vault prefs round-trip as strings.
  assert.equal(langfuse.configureLangfuse({ ...KEYS, langfuseTracing: 'false' }), false);
  langfuse.configureLangfuse(KEYS, { exporter });
  assert.equal(langfuse.langfuseEnabled(), true);
});

test('private local inference is never exported', async () => {
  // Arrange
  let called = false;

  // Act
  const observed = await langfuse.traceAgentRun(
    { name: 'agent-runtime:deepagent', model: 'local-model', llm: { provider: 'lmstudio' } },
    async () => {
      called = true;
      return 'private';
    }
  );

  // Assert
  assert.equal(observed, 'private');
  assert.equal(called, true);
  assert.deepEqual(spans(), []);
});

test('a run inside an untraced region is never exported', async () => {
  // Arrange — local-intelligence.js wraps on-machine model calls in runUntraced(),
  // so a hosted run that happens to call one cannot carry its prompt to the sink.
  let insideUntraced = null;

  // Act
  const observed = await langfuse.runUntraced(() =>
    langfuse.traceAgentRun(
      { name: 'agent-runtime:deepagent', model: 'gpt-5', llm: { provider: 'openrouter' } },
      async () => {
        insideUntraced = langfuse.isUntraced();
        return 'private';
      }
    )
  );

  // Assert
  assert.equal(insideUntraced, true);
  assert.equal(observed, 'private');
  assert.deepEqual(spans(), []);
  assert.equal(langfuse.isUntraced(), false); // the region ends with the callback
});

test('a slow exporter cannot delay or fail the run beyond the flush budget', async () => {
  // Arrange
  exporter.delayMs = 200;
  const startedAt = Date.now();

  // Act
  const observed = await langfuse.traceAgentRun({ name: 'agent-runtime:qoder-sdk', llm: {} }, async () => 'slow');

  // Assert
  assert.equal(observed, 'slow');
  assert.ok(Date.now() - startedAt < 150, 'the 40ms test budget did not bound the export');
  await new Promise((resolve) => setTimeout(resolve, 250));
  exporter.delayMs = 0;
  spans();
});

test('the default export budget is the 3s Cloud Run allowance', () => {
  assert.equal(langfuse.FLUSH_TIMEOUT_MS, 3_000);
});

test('traceUrlFor links a trace inside the configured project', async () => {
  // Act
  const url = await langfuse.traceUrlFor('0123456789abcdef0123456789abcdef');

  // Assert
  assert.equal(url, 'https://cloud.langfuse.com/project/proj-test/traces/0123456789abcdef0123456789abcdef');
});

test('an absent trace id yields no link', async () => {
  assert.equal(await langfuse.traceUrlFor(''), null);
  assert.equal(await langfuse.traceUrlFor(undefined), null);
});

test('direct mode needs a real secret pair before tracing can be enabled', () => {
  // Arrange / Act / Assert — no EGRESS_PROXY_URL in this profile, so a public key
  // alone cannot authenticate an export.
  assert.equal(langfuse.configureLangfuse({ langfusePublicKey: 'pk-lf-test' }, { exporter }), false);
  langfuse.configureLangfuse(KEYS, { exporter });
});
