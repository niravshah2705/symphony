'use strict';

/**
 * Agent analytics read path: Langfuse Cloud.
 *
 * Langfuse's legacy trace/observation endpoints are already retired for an
 * organization created after the v3 cutoff — they answer 410
 * LEGACY_API_UNAVAILABLE_FOR_NEW_ORGANIZATION — so every read here targets
 * `/api/public/v2/observations`, which returns *observations*, not traces. A run
 * is rebuilt from its logical root (the dispatch span, which carries the name,
 * tags, session, user and metadata) plus the token usage and cost summed across
 * that trace's non-root observations. Langfuse books usage on the generation and
 * never on the root, so reading roots alone would report every run as free;
 * excluding roots from the sum is also what stops a trace-level rollup from being
 * counted twice against the generation it summarizes.
 *
 * Under EGRESS_PROXY_URL the planner has no direct egress either, so the client
 * points at the sidecar's `/langfuse` prefix with the sentinel pair and the
 * sidecar injects the vault-resolved `Basic base64(publicKey:secretKey)`. Only in
 * the trusted local profile are the real keys read from settings.
 */

const { LangfuseClient } = require('@langfuse/client');

const { CONFIG } = require('../config');
const { SENTINEL_TOKEN } = require('../egress');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 24 * 7;
const MAX_WINDOW_HOURS = 24 * 30;
const DEFAULT_TRACE_LIMIT = 100;
const MAX_TRACE_LIMIT = 250;
const LANGFUSE_TIMEOUT_SECONDS = 8;
// Rows per upstream page and a hard page bound: one Analytics request must not
// turn into an unbounded number of calls against a wide window.
const PAGE_ROWS = 500;
const MAX_PAGES = 8;
// Trace ids are filtered in chunks, so the query string stays well inside what a
// proxy accepts while each chunk still costs exactly one request.
const TRACE_ID_CHUNK = 100;
// `core` + `basic` arrive by default; every other group is opt-in and simply
// absent when not requested. `io` is deliberately never requested — the table
// shows identities and numbers, never prompt or result text.
const ROOT_FIELDS = 'core,basic,metadata,model,usage,trace_context';
const CHILD_FIELDS = 'core,basic,usage';
// Metadata values over 200 characters are truncated unless named here, and a
// truncated array would silently corrupt the resource rollups.
const EXPAND_METADATA = [
  'skills', 'tools', 'plugins',
  'skills_used', 'tools_used', 'plugins_used',
].join(',');

const RESOURCE_MAX_ITEMS = 100;
const TOP_RESOURCE_LIMIT = 10;

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function finiteMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanText(value, maximum = 120) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function firstText(values, maximum = 120) {
  for (const value of values) {
    const text = cleanText(value, maximum);
    if (text) return text;
  }
  return null;
}

function metadataFor(trace) {
  return trace && trace.metadata && typeof trace.metadata === 'object' ? trace.metadata : {};
}

function tagValue(trace, prefix) {
  const tags = Array.isArray(trace && trace.tags) ? trace.tags : [];
  for (const tag of tags) {
    const text = cleanText(tag, 200);
    if (text.startsWith(prefix) && text.length > prefix.length) return text.slice(prefix.length);
  }
  return null;
}

/**
 * Read a resource metadata field (skills/tools/plugins), tolerant of both the
 * array shape this app writes and a comma-separated string. Returns a trimmed,
 * de-duplicated, capped list of names.
 */
function resourceNames(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const name = cleanText(entry, 120);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= RESOURCE_MAX_ITEMS) break;
  }
  return out;
}

/** Frequency rollup of a resource category across traces (used → configured). */
function topResources(traces, usedKey, configuredKey, limit = TOP_RESOURCE_LIMIT) {
  const counts = new Map();
  for (const trace of traces) {
    const resources = trace.resources || {};
    const list = resources[usedKey] && resources[usedKey].length ? resources[usedKey] : resources[configuredKey] || [];
    for (const name of list) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function runtimeAndModel(trace) {
  const metadata = metadataFor(trace);
  return {
    runtime: firstText([
      metadata.agent_runtime,
      metadata.harness,
      tagValue(trace, 'runtime:'),
      tagValue(trace, 'harness:'),
    ], 80),
    model: firstText([
      trace && trace.model,
      metadata.model_name,
      tagValue(trace, 'model:'),
    ], 120),
  };
}
function metricFromParts(total, first, second) {
  const explicit = finiteMetric(total);
  if (explicit !== null) return { value: explicit, source: 'reported-total' };
  const left = finiteMetric(first);
  const right = finiteMetric(second);
  if (left === null && right === null) return { value: null, source: 'unavailable' };
  return { value: (left || 0) + (right || 0), source: 'reported-parts' };
}

function latencyMs(trace) {
  const start = Date.parse(trace && trace.startTime);
  const end = Date.parse(trace && trace.endTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  // A root still open when the window was cut has no end time; the API's own
  // latency (seconds) is reported only for completed observations.
  const reported = finiteMetric(trace && trace.latency);
  return reported === null ? null : Math.round(reported * 1000);
}

function isErrorTrace(trace) {
  return cleanText(trace && trace.level, 20).toUpperCase() === 'ERROR';
}

function isoTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Deep link into the Langfuse project that owns the key. The trace id is the
 * OpenTelemetry trace id, so it is pattern-checked rather than trusted, and the
 * result is re-parsed so a misconfigured base URL can never smuggle credentials
 * or an off-site origin into the Analytics table.
 */
function safeTraceUrl(traceId, base) {
  const id = cleanText(traceId, 120);
  const link = cleanText(base, 2000);
  if (!/^[0-9a-f]{16,64}$/i.test(id) || !link) return null;
  try {
    const origin = new URL(CONFIG.LANGFUSE.origin);
    const target = new URL(`${link}/traces/${id}`);
    if (target.origin !== origin.origin) return null;
    target.username = '';
    target.password = '';
    return target.toString();
  } catch (_) {
    return null;
  }
}

/**
 * Shape one reconstructed run for the Analytics table. `trace.usage` and
 * `trace.cost` are the sums over the trace's child observations, joined in by the
 * loader; every other field comes from the logical root.
 */
function normalizeRun(trace, options = {}) {
  trace = trace && typeof trace === 'object' ? trace : {};
  const metadata = metadataFor(trace);
  const usage = trace.usage && typeof trace.usage === 'object' ? trace.usage : {};
  const cost = trace.cost && typeof trace.cost === 'object' ? trace.cost : {};
  const promptTokens = finiteMetric(usage.input);
  const completionTokens = finiteMetric(usage.output);
  const tokens = metricFromParts(usage.total, promptTokens, completionTokens);
  const promptCost = finiteMetric(cost.input);
  const completionCost = finiteMetric(cost.output);
  const total = metricFromParts(cost.total, promptCost, completionCost);
  const runtime = runtimeAndModel(trace);
  const project = firstText([metadata.project, metadata.business], 100);
  const taskId = firstText([metadata['task-id'], metadata.task_id, metadata.taskId], 80);
  const sessionId = firstText([metadata.session, metadata.session_id, trace.sessionId], 120);
  const name = cleanText(trace.name || trace.traceName, 160) || 'Agent change';
  const failed = isErrorTrace(trace);
  const resources = {
    skills: resourceNames(metadata.skills),
    tools: resourceNames(metadata.tools),
    plugins: resourceNames(metadata.plugins),
    skillsUsed: resourceNames(metadata.skills_used),
    toolsUsed: resourceNames(metadata.tools_used),
    pluginsUsed: resourceNames(metadata.plugins_used),
  };

  return {
    id: cleanText(trace.traceId, 120) || null,
    traceId: cleanText(trace.traceId, 120) || null,
    name,
    change: {
      label: [taskId, name].filter(Boolean).join(' · '),
      project,
      taskId,
      sessionId,
    },
    resources,
    startedAt: isoTime(trace.startTime),
    finishedAt: isoTime(trace.endTime),
    latencyMs: latencyMs(trace),
    // Langfuse records a severity, not a workflow status: a trace whose root is
    // not ERROR completed (dispatch.js raises the root to ERROR on failure).
    status: failed ? 'error' : 'success',
    hasError: failed,
    runtime: runtime.runtime,
    model: runtime.model,
    traceUrl: safeTraceUrl(trace.traceId, options.traceBase),
    tokens: {
      total: tokens.value,
      prompt: promptTokens,
      completion: completionTokens,
      source: tokens.source,
    },
    cost: {
      totalUsd: total.value,
      promptUsd: promptCost,
      completionUsd: completionCost,
      source: total.source,
    },
  };
}
function sumAvailable(items, selector) {
  let total = 0;
  let coverage = 0;
  for (const item of items) {
    const value = selector(item);
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    total += value;
    coverage += 1;
  }
  return { value: coverage ? total : null, coverage };
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function aggregateRuns(runs, options = {}) {
  const traces = runs.map((run) => normalizeRun(run, options)).sort((left, right) => {
    return Date.parse(right.startedAt || 0) - Date.parse(left.startedAt || 0);
  });
  const costs = sumAvailable(traces, (trace) => trace.cost.totalUsd);
  const tokens = sumAvailable(traces, (trace) => trace.tokens.total);
  const inputTokens = sumAvailable(traces, (trace) => trace.tokens.prompt);
  const outputTokens = sumAvailable(traces, (trace) => trace.tokens.completion);
  const latencies = traces.map((trace) => trace.latencyMs).filter(Number.isFinite);
  const latencyTotal = latencies.reduce((sum, value) => sum + value, 0);
  const errorCount = traces.filter((trace) => trace.hasError).length;

  return {
    summary: {
      traceCount: traces.length,
      errorCount,
      errorRate: traces.length ? errorCount / traces.length : 0,
      inputTokens: inputTokens.value,
      outputTokens: outputTokens.value,
      totalTokens: tokens.value,
      tokenCoverage: { reported: tokens.coverage, total: traces.length },
      totalCostUsd: costs.value,
      costCoverage: { reported: costs.coverage, total: traces.length },
      averageLatencyMs: latencies.length ? latencyTotal / latencies.length : null,
      p95LatencyMs: percentile(latencies, 0.95),
      latencyCoverage: { reported: latencies.length, total: traces.length },
      resourceUsage: {
        tools: topResources(traces, 'toolsUsed', 'tools'),
        skills: topResources(traces, 'skillsUsed', 'skills'),
        plugins: topResources(traces, 'pluginsUsed', 'plugins'),
      },
    },
    traces,
  };
}
function unavailable(reason, options, message) {
  return {
    availability: 'unavailable',
    source: 'langfuse',
    reason,
    message,
    window: {
      startAt: options.startTime.toISOString(),
      endAt: options.now.toISOString(),
      hours: options.hours,
      limit: options.limit,
    },
    summary: null,
    traces: [],
  };
}

function normalizeOptions(input = {}) {
  const nowValue = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const now = Number.isFinite(nowValue.getTime()) ? nowValue : new Date();
  const hours = boundedInteger(input.hours, 1, MAX_WINDOW_HOURS, DEFAULT_WINDOW_HOURS);
  const limit = boundedInteger(input.limit, 1, MAX_TRACE_LIMIT, DEFAULT_TRACE_LIMIT);
  return {
    now,
    hours,
    limit,
    orgId: cleanText(input.orgId, 120),
    startTime: new Date(now.getTime() - hours * HOUR_MS),
  };
}

// One attempt, bounded: a stalled Langfuse must not stack retries behind a
// browser request that already has its own timeout.
function requestOptions() {
  return { timeoutInSeconds: LANGFUSE_TIMEOUT_SECONDS, maxRetries: 0 };
}

/**
 * Walk cursor-paged v2 responses. A page can arrive empty while still carrying a
 * cursor, so only an absent cursor ends the walk; `shouldStop` lets the caller cut
 * the walk once it has enough rows and MAX_PAGES bounds the worst case.
 */
async function pagedObservations(client, request, shouldStop) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.api.observations.getMany(
      { ...request, ...(cursor ? { cursor } : {}), limit: PAGE_ROWS },
      requestOptions()
    );
    for (const row of response && Array.isArray(response.data) ? response.data : []) rows.push(row || {});
    cursor = response && response.meta && response.meta.cursor ? String(response.meta.cursor) : null;
    if (!cursor || (shouldStop && shouldStop(rows))) break;
  }
  return rows;
}

function scopeFilters(orgId) {
  return orgId
    ? [{ column: 'tags', type: 'arrayOptions', operator: 'all of', value: [`org:${orgId}`] }]
    : [];
}

function windowRequest(options, orgId, fields) {
  return {
    fromStartTime: options.startTime.toISOString(),
    toStartTime: options.now.toISOString(),
    // environment partitions dev / staging / prod, so a dev window never
    // contributes to the production cost table.
    environment: CONFIG.LANGFUSE.environment,
    fields,
    expandMetadata: EXPAND_METADATA,
    ...(orgId ? { filter: JSON.stringify(scopeFilters(orgId)) } : {}),
  };
}
/** One row per run: the logical root observation, newest first, de-duplicated. */
async function fetchRoots(client, options, orgId) {
  const rows = await pagedObservations(
    client,
    { ...windowRequest(options, orgId, ROOT_FIELDS), isRootObservation: true },
    (collected) => collected.length >= options.limit
  );
  const seen = new Set();
  const roots = [];
  for (const row of rows) {
    const traceId = cleanText(row.traceId, 120);
    if (!traceId || seen.has(traceId)) continue;
    seen.add(traceId);
    roots.push(row);
    if (roots.length >= options.limit) break;
  }
  return roots;
}

function addTo(target, key, value) {
  const number = finiteMetric(value);
  if (number !== null) target[key] = (target[key] || 0) + number;
}

/**
 * Sum usage and cost across each trace's child observations. Roots are excluded
 * (Langfuse books usage on generations, and a trace-level rollup would otherwise
 * be double counted), and the trace ids are filtered in chunks so only runs the
 * table actually shows contribute.
 */
async function fetchUsage(client, options, orgId, traceIds) {
  const usage = new Map();
  for (let index = 0; index < traceIds.length; index += TRACE_ID_CHUNK) {
    const chunk = traceIds.slice(index, index + TRACE_ID_CHUNK);
    const rows = await pagedObservations(client, {
      ...windowRequest(options, orgId, CHILD_FIELDS),
      isRootObservation: false,
      filter: JSON.stringify(scopeFilters(orgId).concat([
        { column: 'traceId', type: 'stringOptions', operator: 'any of', value: chunk },
      ])),
    });
    for (const row of rows) {
      const traceId = cleanText(row.traceId, 120);
      if (!traceId || !chunk.includes(traceId)) continue;
      let acc = usage.get(traceId);
      if (!acc) {
        acc = { usage: {}, cost: {} };
        usage.set(traceId, acc);
      }
      const details = row.usageDetails && typeof row.usageDetails === 'object' ? row.usageDetails : {};
      addTo(acc.usage, 'input', details.input);
      addTo(acc.usage, 'output', details.output);
      addTo(acc.usage, 'total', details.total);
      addTo(acc.cost, 'input', row.inputCost);
      addTo(acc.cost, 'output', row.outputCost);
      addTo(acc.cost, 'total', row.totalCost);
    }
  }
  return usage;
}

/**
 * `GET /api/public/projects` returns exactly the project the key belongs to, and a
 * trace deep link needs that id. An optional LANGFUSE_PROJECT_ID skips the call.
 */
async function resolveTraceBase(client) {
  const origin = CONFIG.LANGFUSE.origin;
  const configured = cleanText(CONFIG.LANGFUSE.projectId, 64);
  if (configured) return /^[0-9a-z_-]{6,64}$/i.test(configured) ? `${origin}/project/${configured}` : null;
  try {
    const response = await client.api.projects.get(requestOptions());
    const list = response && Array.isArray(response.data) ? response.data : [];
    const projectId = cleanText(list[0] && list[0].id, 64);
    return /^[0-9a-z_-]{6,64}$/i.test(projectId) ? `${origin}/project/${projectId}` : null;
  } catch (_) {
    return null;
  }
}

function analyticsClient(settings, dependencies) {
  if (dependencies.client) return dependencies.client;
  const proxied = Boolean(CONFIG.EGRESS_PROXY_URL);
  return new (dependencies.Client || LangfuseClient)({
    publicKey: cleanText(settings.langfusePublicKey, 512) || (proxied ? SENTINEL_TOKEN : ''),
    secretKey: cleanText(settings.langfuseSecretKey, 512) || (proxied ? SENTINEL_TOKEN : ''),
    baseUrl: CONFIG.LANGFUSE.url,
  });
}
/**
 * Query a bounded window of runs. Provider failures are deliberately returned as
 * an unavailable state: analytics must not take down the gateway or echo an
 * upstream response body (which can carry workspace details) into the browser.
 */
async function loadAnalytics(settings = {}, input = {}, dependencies = {}) {
  const options = normalizeOptions(input);
  if (settings.langfuseTracing === false || settings.langfuseTracing === 'false') {
    return unavailable('tracing-disabled', options, 'Enable Langfuse tracing to collect change costs and analytics.');
  }
  const publicKey = cleanText(settings.langfusePublicKey, 512);
  const secretKey = cleanText(settings.langfuseSecretKey, 512);
  const proxied = Boolean(CONFIG.EGRESS_PROXY_URL);
  if (!publicKey || (!proxied && !secretKey)) {
    return unavailable('keys-missing', options, 'Add the Langfuse API key pair to load traced change costs.');
  }
  // One platform-managed Langfuse project serves every organization, so tenancy is
  // read-side as well as write-side: the org tag dispatch.js stamps on each trace
  // scopes the query. A caller-supplied org wins; a dedicated per-tenant stack
  // falls back to the org it bills to; and a signed-in deployment with neither must
  // not show one tenant the traces of another.
  const requestedOrg = cleanText(options.orgId, 120);
  const orgId = requestedOrg || cleanText(CONFIG.BILLING && CONFIG.BILLING.orgId, 120);
  if (!orgId && CONFIG.AUTH && CONFIG.AUTH.enabled) {
    return unavailable('org-missing', options, 'Analytics cannot scope a shared Langfuse project without an organization id.');
  }

  try {
    const client = analyticsClient(settings, dependencies);
    const roots = await fetchRoots(client, options, orgId);
    const usage = await fetchUsage(client, options, orgId, roots.map((row) => cleanText(row.traceId, 120)));
    const traceBase = await resolveTraceBase(client);
    const runs = roots.map((row) => ({
      ...row,
      ...(usage.get(cleanText(row.traceId, 120)) || {}),
    }));
    const aggregate = aggregateRuns(runs, { traceBase });
    return {
      availability: 'available',
      source: 'langfuse',
      reason: null,
      message: runs.length ? null : 'No agent runs were recorded in this time window.',
      project: traceBase ? cleanText(traceBase.split('/').pop(), 64) : null,
      window: {
        startAt: options.startTime.toISOString(),
        endAt: options.now.toISOString(),
        hours: options.hours,
        limit: options.limit,
      },
      ...aggregate,
    };
  } catch (_) {
    return unavailable(
      'provider-unavailable',
      options,
      'Langfuse analytics could not be reached. Check the tracing keys, environment, project, and network access.'
    );
  }
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  DEFAULT_TRACE_LIMIT,
  MAX_TRACE_LIMIT,
  LANGFUSE_TIMEOUT_SECONDS,
  normalizeOptions,
  normalizeRun,
  aggregateRuns,
  loadAnalytics,
};
