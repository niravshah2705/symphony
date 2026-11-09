'use strict';

const fs = require('fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { CONFIG } = require('./config');
const { cleanTraceparent, traceIdOf } = require('./traceparent');

/**
 * Dead-simple logger: writes timestamped lines to stdout AND appends them to
 * data/app.log so `tail -f data/app.log` shows every step. No external deps.
 *
 * Every line also carries the run correlation handles it can see (organization,
 * project, run, trace). Without them a log line is unattributable: an operator
 * chasing one failed run has to guess which of ten concurrent tenants' lines to
 * read, which is the difference between an incident and an outage.
 */

const LOG_CONTEXT = new AsyncLocalStorage();
// Cloud Logging joins a log line to its trace through this field; the value is
// a trace resource name, not an id, so it needs the project.
const TRACE_FIELD = 'logging.googleapis.com/trace';

function ensureDir() {
  if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}

/**
 * Serialize an optional structured payload onto the log line. Callers pass the
 * provider response or error context as the second argument (e.g. a Cashfree
 * `status` + `data`); dropping it silently makes an upstream rejection
 * unattributable in Cloud Run logs.
 */
function formatMeta(meta) {
  if (meta === undefined || meta === null) return '';
  if (typeof meta === 'string') return ` ${meta}`;
  let redacted;
  try {
    redacted = JSON.stringify(meta, secretsAsMask, 0);
  } catch (_) {
    redacted = String(meta);
  }
  return redacted ? ` ${redacted}` : '';
}

// Never let a credential-shaped field reach a log sink, whatever the caller put
// in the meta object.
const SECRET_KEY_RE = /(secret|apikey|api_key|token|password|passwd|authorization|credential)/i;
function secretsAsMask(key, value) {
  if (typeof value === 'string' && SECRET_KEY_RE.test(key)) return value ? '••••' : value;
  if (Buffer.isBuffer(value)) return '••••';
  return value;
}

/**
 * The correlation fields for this line: what the caller bound, what is ambient
 * for the current async operation, and the ids already in the meta payload.
 * Only known-good values are emitted — a partial or fabricated trace id is
 * worse than none, because it renders as a broken trace in every UI.
 */
function contextFields(meta) {
  const bound = LOG_CONTEXT.getStore() || {};
  const source = { ...bound, ...(meta && typeof meta === 'object' ? meta : {}) };
  const traceparent = cleanTraceparent(source.traceparent);
  const traceId = isTraceId(source.traceId) ? String(source.traceId).toLowerCase() : traceIdOf(traceparent);  return {
    organizationId: source.organizationId || source.orgId || '',
    projectId: source.projectId || '',
    runId: source.runId || '',
    traceId,
  };
}

/** Cloud Logging jumps from a line to its trace only given a trace resource name. */
function withTraceLink(fields) {
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
  return fields.traceId && project
    ? { ...fields, [TRACE_FIELD]: `projects/${project}/traces/${fields.traceId}` }
    : fields;
}

function jsonLine(level, message, fields, meta) {
  const line = {
    timestamp: new Date().toISOString(),
    severity: level.toUpperCase(),
    service: process.env.FLEET_SERVICE || process.env.SERVICE_NAME || process.env.K_SERVICE || '',
    message,
  };
  for (const [key, value] of Object.entries(fields)) if (value) line[key] = value;
  if (meta !== undefined && meta !== null) {
    try {
      line.meta = JSON.parse(JSON.stringify(meta, secretsAsMask));
    } catch (_) {
      line.meta = String(meta);
    }
  }
  return JSON.stringify(line);
}

function textLine(level, message, fields, meta) {
  const ts = new Date().toISOString();
  const handles = Object.entries(fields)
    .filter(([key, value]) => value && key !== TRACE_FIELD)
    .map(([key, value]) => `${HANDLE_LABELS[key] || key}=${value}`)
    .join(' ');
  return `[${ts}] ${level.toUpperCase().padEnd(5)} ${message}${handles ? ` {${handles}}` : ''}${formatMeta(meta)}`;
}

function write(level, message, meta, bound = {}) {
  const fields = withTraceLink({ ...contextFields(meta), ...cleanBound(bound) });
  const json = String(process.env.LOG_FORMAT || '').toLowerCase() === 'json';
  const text = json
    ? jsonLine(level, message, fields, meta)
    : textLine(level, message, fields, meta);
  // eslint-disable-next-line no-console
  console.log(text);
  try {
    ensureDir();
    fs.appendFileSync(CONFIG.LOG_FILE, `${text}\n`);
  } catch (_) {
    /* logging must never throw */
  }
  return text;
}

const HANDLE_LABELS = { organizationId: 'org', projectId: 'project', runId: 'run', traceId: 'trace' };
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const isTraceId = (value) => TRACE_ID_RE.test(String(value || '').toLowerCase());

/** Same normalization as contextFields, for fields supplied by a bound logger. */
function cleanBound(bound) {
  const out = {};
  for (const [key, value] of Object.entries(bound || {})) {
    if (!value) continue;
    if (key === 'traceId' && !isTraceId(value)) continue;
    if (key === 'traceparent') {
      const clean = cleanTraceparent(value);
      if (clean) out.traceId = traceIdOf(clean);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * A logger with these correlation fields attached to every line it writes.
 * Use it where the ids are known but no ambient context was established:
 * `const tlog = log.withContext({ runId })`.
 */
function withContext(context = {}) {
  return {
    info: (message, meta) => write('info', message, meta, context),
    warn: (message, meta) => write('warn', message, meta, context),
    error: (message, meta) => write('error', message, meta, context),
  };
}

/**
 * Run `fn` with these fields ambient, so every log line anywhere inside it —
 * including code that never heard of logging — carries them. One call per
 * request or job, at the boundary that validates the ids.
 */
function runWithContext(context, fn) {
  if (typeof fn !== 'function') throw new TypeError('runWithContext requires a function');
  return LOG_CONTEXT.run(cleanBound(context), fn);
}

function currentContext() {
  return LOG_CONTEXT.getStore() || {};
}

module.exports = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
  withContext,
  runWithContext,
  currentContext,
  LOG_FILE: CONFIG.LOG_FILE,
};
