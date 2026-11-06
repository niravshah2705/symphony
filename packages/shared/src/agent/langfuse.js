'use strict';

/**
 * Langfuse Cloud tracing for every agent harness.
 *
 * One trace per dispatched agent run. The root observation carries the run name,
 * the truncated prompt and the public execution result; a single child `generation`
 * carries model, token usage and cost so Langfuse can do cost/usage analytics per
 * harness. The generation deliberately holds NO prompt or output copy — the root
 * already does, and duplicating a 20k prompt would double ingest cost. Per-stage
 * nested observations are a later seam (see docs plan, Stage A).
 *
 * Bootstrapping is minimal on purpose: a BasicTracerProvider with only a
 * LangfuseSpanProcessor and an AsyncLocalStorage context manager. No
 * auto-instrumentation, so nothing except these observations is ever exported.
 *
 * Credentials never live in an agent container. Under EGRESS_PROXY_URL the SDK is
 * pointed at the sidecar's /langfuse prefix with the sentinel pair, and the sidecar
 * replaces the whole Authorization header with the vault-resolved
 * `Basic base64(publicKey:secretKey)` (auth family `basic-pair`,
 * services/proxy/src/credentials.js). The pair is configured in-process only:
 * OTEL_EXPORTER_OTLP_HEADERS would place a real Basic pair in the container env,
 * where the codex harness's `*KEY*`/`*SECRET*` subshell redaction does not reach it.
 *
 * Export is fail-open. A Langfuse outage or a slow ingest response must never fail
 * or delay a completed run, so every flush is awaited under a fixed budget and
 * errors are swallowed with a warning.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { CONFIG } = require('../config');
const { SENTINEL_TOKEN } = require('../egress');
const { TRACEPARENT_HEADER, cleanTraceparent } = require('@ai-fleet/shared-core/traceparent');
const log = require('../logger');
const { isLocalInference } = require('./model-presets');

const FLUSH_TIMEOUT_MS = 3_000;
const PROJECT_TIMEOUT_MS = 3_000;
const MAX_TAG_CHARS = 200;

let runtime = null; // { provider, processor, publicKey, secretKey, on }
let projectPromise = null;
const untracedRegion = new AsyncLocalStorage();

function bounded(value, max = MAX_TAG_CHARS) {
  const text = value === null || value === undefined ? '' : String(value).replace(/\r\n?/g, ' ').trim();
  return text.slice(0, max);
}

/**
 * Enable (or disable) Langfuse export for this process from resolved settings keys.
 * Mirrors the old LangSmith `configureTracing` posture: process-global, called per
 * run, so a concurrent run from another organization can flip the `on` flag. The
 * transport itself is bootstrapped once — a second provider cannot replace the
 * global OpenTelemetry registration.
 *
 * `deps` exists for tests only: `exporter` swaps the OTLP exporter (so a suite can
 * read the emitted spans instead of dialing the network) and `flushTimeoutMs` bounds
 * the export wait.
 */
function configureLangfuse(keys = {}, deps = {}) {
  const proxied = Boolean(CONFIG.EGRESS_PROXY_INCLUDE_SDK);
  const disabled = keys.langfuseTracing === false || keys.langfuseTracing === 'false';
  // The public key is not a secret, so a deployment may hand the agent the real one.
  // A sentinel is equally fine under proxy mode because the sidecar rebuilds both
  // halves of the Basic pair. Outside proxy mode (trusted local development) both
  // halves must be real, or there is nothing to authenticate with.
  const publicKey = bounded(keys.langfusePublicKey, 512) || (proxied ? SENTINEL_TOKEN : '');
  const secretKey = proxied ? SENTINEL_TOKEN : bounded(keys.langfuseSecretKey, 512);
  const on = !disabled && Boolean(publicKey && secretKey);
  if (!on) {
    if (runtime) runtime.on = false;
    return false;
  }
  if (!runtime) {
    try {
      runtime = bootstrap({ publicKey, secretKey, exporter: deps.exporter });
      if (Number.isFinite(deps.flushTimeoutMs)) runtime.flushTimeoutMs = deps.flushTimeoutMs;
    } catch (error) {
      log.warn(`Langfuse tracing disabled: ${error && error.message ? error.message : error}`);
      return false;
    }
  } else {
    runtime.publicKey = publicKey;
    runtime.secretKey = secretKey;
  }
  runtime.on = true;
  return true;
}

function bootstrap({ publicKey, secretKey, exporter }) {
  const api = require('@opentelemetry/api');
  const { BasicTracerProvider } = require('@opentelemetry/sdk-trace-base');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const { LangfuseSpanProcessor } = require('@langfuse/otel');
  const { propagateAttributes, startActiveObservation, getActiveTraceId } = require('@langfuse/tracing');

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl: CONFIG.LANGFUSE.url,
    environment: CONFIG.LANGFUSE.environment,
    mediaUploadEnabled: false,
    ...(exporter ? { exporter } : {}),
  });
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
    // Without a resource, OTel defaults to `unknown_service:node`, which Langfuse
    // surfaces on every trace — the service dimension is what separates the
    // planner / coder / worker populations in the Langfuse UI.
    resource: resourceFromAttributes({
      'service.name': CONFIG.LANGFUSE.serviceName,
      'deployment.environment.name': CONFIG.LANGFUSE.environment,
    }),
  });
  api.trace.setGlobalTracerProvider(provider);
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  if (!api.context.setGlobalContextManager(contextManager)) {
    log.warn('Langfuse: another OpenTelemetry context manager is already registered; nested observations may not link to their run.');
  }
  return {
    provider,
    processor,
    publicKey,
    secretKey,
    on: true,
    flushTimeoutMs: FLUSH_TIMEOUT_MS,
    sdk: {
      propagateAttributes,
      startActiveObservation,
      getActiveTraceId,
      // The OTel propagation API is how a run crosses a process boundary: it
      // writes and reads the W3C `traceparent` header for the active span.
      propagation: api.propagation,
      context: api.context,
    },
  };
}

function langfuseEnabled() {
  return Boolean(runtime && runtime.on);
}

/**
 * The W3C `traceparent` for the span this operation is currently inside, or null.
 *
 * This is what lets one run be read as one trace after it leaves the process:
 * the value goes on the outbound header of a substrate actor dispatch, a Pub/Sub
 * message, or a coder job env, and the far side continues the same trace instead
 * of starting an unrelated one. Null whenever tracing is not bootstrapped — an
 * id that no span was ever recorded against would render as a broken trace, so
 * we would rather forward nothing.
 */
function currentTraceparent() {
  if (!runtime || !runtime.sdk.context) return null;
  const carrier = {};
  try {
    runtime.sdk.propagation.inject(runtime.sdk.context.active(), carrier);
  } catch (_) {
    return null;
  }
  return cleanTraceparent(carrier.traceparent) || null;
}

/**
 * Continue a trace that arrived from another process: the remote span becomes
 * the parent of anything traced inside `execute`. A pass-through when tracing is
 * off or the header is unusable — a run is never failed by its telemetry.
 */
function runWithRemoteTraceparent(traceparent, execute) {
  const clean = cleanTraceparent(traceparent);
  if (!clean || !runtime || !runtime.sdk.context) return execute();
  const context = runtime.sdk.context;
  const remote = runtime.sdk.propagation.extract(context.active(), { [TRACEPARENT_HEADER]: clean });
  return context.with(remote, execute);
}

/**
 * Privacy gate: local inference must never be exported to a third-party trace sink.
 * Replaces the LangSmith `RunTree(tracingEnabled:false)` context that
 * local-intelligence.js used to wrap its own invokes in.
 */
function isPrivateLlm(llm) {
  return isLocalInference(llm && llm.provider);
}

/**
 * Mark an async region as privacy-sensitive: nothing traced inside it, even when a
 * hosted run is currently being traced around it. Callers use this for content that
 * is promised to stay on the machine (local-model enrichment) rather than relying on
 * the provider name alone, which a mixed-mode run can change mid-flight.
 */
function runUntraced(execute) {
  return untracedRegion.run(true, execute);
}

function isUntraced() {
  return untracedRegion.getStore() === true;
}

/**
 * Run `execute` inside one Langfuse trace. Pass-through when tracing is off or the
 * run is private local inference.
 *
 * @param {object} opts
 * @param {string} opts.name              root observation name
 * @param {string} [opts.traceName]       trace name (defaults to opts.name)
 * @param {*}      [opts.input]           prompt, pre-truncated by the caller
 * @param {object} [opts.metadata]        run metadata (harness, pattern, provider…)
 * @param {string[]} [opts.tags]          org/project/harness/model dimensions
 * @param {string} [opts.userId]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.model]           model name for the generation child
 * @param {object} [opts.llm]             resolved LLM — a private provider skips tracing
 * @param {Function} [opts.describe]      (value) => { metadata, usageDetails, costDetails }
 * @param {Function} [opts.onTraceId]     (traceId) => void, called before `execute`
 */
async function traceAgentRun(opts = {}, execute) {
  if (!langfuseEnabled() || isPrivateLlm(opts.llm) || isUntraced()) return execute();
  const { propagateAttributes, startActiveObservation, getActiveTraceId } = runtime.sdk;
  const rootName = bounded(opts.name || 'agent-run', 200);
  const scope = { traceName: bounded(opts.traceName || opts.name || 'agent-run', 200) };
  const userId = bounded(opts.userId);
  const sessionId = bounded(opts.sessionId);
  if (userId) scope.userId = userId;
  if (sessionId) scope.sessionId = sessionId;
  const tags = [...new Set((Array.isArray(opts.tags) ? opts.tags : []).map((tag) => bounded(tag)).filter(Boolean))];
  if (tags.length) scope.tags = tags;

  try {
    return await propagateAttributes(scope, async () =>
      startActiveObservation(rootName, async (span) => {
        const traceId = getActiveTraceId() || null;
        if (opts.onTraceId) {
          try {
            opts.onTraceId(traceId);
          } catch (_) {
            /* reporting the trace id is diagnostics, never a run failure */
          }
        }
        const generation = opts.model
          ? span.startObservation('llm', { model: bounded(opts.model, 200) }, { asType: 'generation' })
          : null;
        const detailOf = (value) => {
          if (typeof opts.describe !== 'function') return {};
          try {
            return opts.describe(value) || {};
          } catch (_) {
            return {};
          }
        };
        const rootBase = {
          ...(opts.input === undefined ? {} : { input: opts.input }),
          ...(opts.metadata ? { metadata: opts.metadata } : {}),
        };
        try {
          const result = await execute();
          const detail = detailOf(result);
          span.update({
            ...rootBase,
            output: detail.output === undefined ? result : detail.output,
            ...(detail.metadata ? { metadata: { ...(opts.metadata || {}), ...detail.metadata } } : {}),
          });
          if (generation) {
            generation.update({
              ...(detail.usageDetails ? { usageDetails: detail.usageDetails } : {}),
              ...(detail.costDetails ? { costDetails: detail.costDetails } : {}),
            });
            generation.end(new Date());
          }
          return result;
        } catch (error) {
          const message = error && error.message ? bounded(error.message, 2_000) : 'Agent run failed.';
          const detail = detailOf(error);
          span.update({
            ...rootBase,
            output: { error: message },
            level: 'ERROR',
            statusMessage: message,
            ...(detail.metadata ? { metadata: { ...(opts.metadata || {}), ...detail.metadata } } : {}),
          });
          if (generation) {
            generation.update({
              level: 'ERROR',
              statusMessage: message,
              ...(detail.usageDetails ? { usageDetails: detail.usageDetails } : {}),
              ...(detail.costDetails ? { costDetails: detail.costDetails } : {}),
            });
            generation.end(new Date());
          }
          throw error;
        }
      })
    );
  } finally {
    await flushLangfuse();
  }
}

/** Await a bounded export. Never throws, never stalls a finished run. */
async function flushLangfuse() {
  if (!runtime || !runtime.provider) return;
  let timer = null;
  try {
    await Promise.race([
      runtime.provider.forceFlush(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, runtime.flushTimeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
  } catch (error) {
    log.warn(`Langfuse export failed (run unaffected): ${error && error.message ? error.message : error}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the Langfuse project id the configured key belongs to — once per process,
 * cached on success only so a transient failure can be retried by a later run.
 */
async function resolveProjectId() {
  if (CONFIG.LANGFUSE.projectId) return CONFIG.LANGFUSE.projectId;
  if (!runtime) return null;
  if (!projectPromise) {
    projectPromise = fetchProjectId().then((id) => id || releaseProjectCache()).catch(() => releaseProjectCache());
  }
  return projectPromise;
}

function releaseProjectCache() {
  projectPromise = null;
  return null;
}

async function fetchProjectId() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROJECT_TIMEOUT_MS);
  try {
    const auth = Buffer.from(`${runtime.publicKey}:${runtime.secretKey}`).toString('base64');
    const response = await fetch(`${CONFIG.LANGFUSE.url}/api/public/projects`, {
      headers: { authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    // The public API returns the caller's projects as `data`; keep parsing
    // tolerant of a renamed envelope rather than 404ing a deep link.
    const list = Array.isArray(body && body.data) ? body.data : Array.isArray(body && body.projects) ? body.projects : [];
    return bounded((list[0] && list[0].id) || '');
  } finally {
    clearTimeout(timer);
  }
}

/** Deep link for the browser "Open trace" action; falls back to the project list. */
async function traceUrlFor(traceId) {
  const id = bounded(traceId, 64);
  if (!id) return null;
  const projectId = await resolveProjectId();
  return projectId
    ? `${CONFIG.LANGFUSE.origin}/project/${projectId}/traces/${id}`
    : `${CONFIG.LANGFUSE.origin}/project`;
}

module.exports = {
  configureLangfuse,
  langfuseEnabled,
  isPrivateLlm,
  runUntraced,
  isUntraced,
  traceAgentRun,
  currentTraceparent,
  runWithRemoteTraceparent,
  flushLangfuse,
  traceUrlFor,
  FLUSH_TIMEOUT_MS,
};
