'use strict';

const { Client } = require('langsmith');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 24 * 7;
const MAX_WINDOW_HOURS = 24 * 30;
const DEFAULT_TRACE_LIMIT = 100;
const MAX_TRACE_LIMIT = 250;
const LANGSMITH_TIMEOUT_MS = 8000;

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

function metadataFor(run) {
  const extra = run && run.extra && typeof run.extra === 'object' ? run.extra : {};
  return extra.metadata && typeof extra.metadata === 'object' ? extra.metadata : {};
}

function invocationFor(run) {
  const extra = run && run.extra && typeof run.extra === 'object' ? run.extra : {};
  const invocation = extra.invocation_params || extra.invocationParams;
  return invocation && typeof invocation === 'object' ? invocation : {};
}

function firstText(values, maximum = 120) {
  for (const value of values) {
    const text = cleanText(value, maximum);
    if (text) return text;
  }
  return null;
}

const RESOURCE_MAX_ITEMS = 100;
const TOP_RESOURCE_LIMIT = 10;

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

function runtimeAndModel(run) {
  const metadata = metadataFor(run);
  const invocation = invocationFor(run);
  const extra = run && run.extra && typeof run.extra === 'object' ? run.extra : {};
  return {
    runtime: firstText([
      metadata.runtime,
      metadata.sdk,
      metadata.framework,
      metadata.agent_runtime,
      extra.runtime && extra.runtime.library,
      run && run.run_type,
    ], 80),
    model: firstText([
      metadata.ls_model_name,
      metadata.model_name,
      metadata.model,
      invocation.model,
      invocation.model_name,
      extra.model,
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

function latencyMs(run) {
  const start = Date.parse(run && run.start_time);
  const end = Date.parse(run && run.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function isErrorRun(run) {
  if (run && run.error) return true;
  return /^(error|failed|failure)$/i.test(cleanText(run && run.status, 30));
}

function safeTraceUrl(run, hostUrl) {
  const tracePath = cleanText(run && run.app_path, 1000);
  // LangSmith supplies an application-relative path. Reject protocol-relative
  // and backslash variants before URL parsing so a trace cannot become an
  // off-site link in the Analytics UI.
  if (!tracePath || !/^\/(?![\/\\])/.test(tracePath) || tracePath.includes('\\')) return null;
  try {
    const base = new URL(hostUrl || 'https://smith.langchain.com');
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    base.username = '';
    base.password = '';
    const url = new URL(tracePath, base);
    if (url.origin !== base.origin) return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch (_) {
    return null;
  }
}

function normalizeRun(run, options = {}) {
  run = run && typeof run === 'object' ? run : {};
  const metadata = metadataFor(run);
  const promptTokens = finiteMetric(run.prompt_tokens) ?? finiteMetric(metadata.usage_input_tokens);
  const completionTokens = finiteMetric(run.completion_tokens) ?? finiteMetric(metadata.usage_output_tokens);
  const reportedTokens = finiteMetric(run.total_tokens) ?? finiteMetric(metadata.usage_total_tokens);
  const promptCost = finiteMetric(run.prompt_cost);
  const completionCost = finiteMetric(run.completion_cost);
  let cost = metricFromParts(run.total_cost, promptCost, completionCost);
  if (cost.value === null && finiteMetric(metadata.cost_usd) !== null) {
    cost = { value: finiteMetric(metadata.cost_usd), source: 'trace-metadata' };
  }
  let tokens = metricFromParts(reportedTokens, promptTokens, completionTokens);
  if (tokens.value !== null && finiteMetric(run.total_tokens) === null && finiteMetric(metadata.usage_total_tokens) !== null) {
    tokens = { value: tokens.value, source: 'trace-metadata' };
  }
  const runtime = runtimeAndModel(run);
  const project = firstText([metadata.project, metadata.business], 100);
  const taskId = firstText([metadata['task-id'], metadata.task_id, metadata.taskId], 80);
  const sessionId = firstText([metadata.session, metadata.session_id, run.session_id], 120);
  const name = cleanText(run.name, 160) || 'Agent change';
  const resources = {
    skills: resourceNames(metadata.skills),
    tools: resourceNames(metadata.tools),
    plugins: resourceNames(metadata.plugins),
    skillsUsed: resourceNames(metadata.skills_used),
    toolsUsed: resourceNames(metadata.tools_used),
    pluginsUsed: resourceNames(metadata.plugins_used),
  };

  return {
    id: cleanText(run.id || run.trace_id, 120) || null,
    traceId: cleanText(run.trace_id || run.id, 120) || null,
    name,
    change: {
      label: [taskId, name].filter(Boolean).join(' · '),
      project,
      taskId,
      sessionId,
    },
    resources,
    startedAt: Number.isFinite(Date.parse(run.start_time)) ? new Date(run.start_time).toISOString() : null,
    finishedAt: Number.isFinite(Date.parse(run.end_time)) ? new Date(run.end_time).toISOString() : null,
    latencyMs: latencyMs(run),
    status: cleanText(run.status, 30) || (isErrorRun(run) ? 'error' : 'unknown'),
    hasError: isErrorRun(run),
    runtime: runtime.runtime,
    model: runtime.model,
    traceUrl: safeTraceUrl(run, options.hostUrl),
    tokens: {
      total: tokens.value,
      prompt: promptTokens,
      completion: completionTokens,
      source: tokens.source,
    },
    cost: {
      totalUsd: cost.value,
      promptUsd: promptCost,
      completionUsd: completionCost,
      source: cost.source,
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
    source: 'langsmith',
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
  return { now, hours, limit, startTime: new Date(now.getTime() - hours * HOUR_MS) };
}

/**
 * Query a bounded window of root traces. Provider failures are deliberately
 * returned as an unavailable state: analytics must not take down the gateway or
 * expose an upstream response (which can contain workspace details).
 */
async function loadAnalytics(settings = {}, input = {}, dependencies = {}) {
  const options = normalizeOptions(input);
  if (!settings.langsmithTracing) {
    return unavailable('tracing-disabled', options, 'Enable LangSmith tracing to collect change costs and analytics.');
  }
  if (!cleanText(settings.langsmithApiKey, 4096)) {
    return unavailable('api-key-missing', options, 'Add a LangSmith API key to load traced change costs.');
  }
  const projectName = cleanText(settings.langsmithProject, 160);
  if (!projectName) {
    return unavailable('project-missing', options, 'Choose a LangSmith project to load analytics.');
  }

  try {
    const client = dependencies.client || new (dependencies.Client || Client)({
      apiKey: settings.langsmithApiKey,
      apiUrl: settings.langsmithEndpoint || undefined,
      timeout_ms: LANGSMITH_TIMEOUT_MS,
      callerOptions: { maxRetries: 1 },
    });
    const runs = [];
    const iterable = client.listRuns({
      projectName,
      startTime: options.startTime,
      isRoot: true,
      limit: options.limit,
      select: [
        'id', 'trace_id', 'session_id', 'app_path', 'name', 'run_type', 'start_time', 'end_time', 'status', 'error', 'extra',
        'prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cost', 'completion_cost', 'total_cost',
      ],
    });
    for await (const run of iterable) {
      runs.push(run || {});
      if (runs.length >= options.limit) break;
    }
    let hostUrl = null;
    try {
      hostUrl = typeof client.getHostUrl === 'function' ? client.getHostUrl() : null;
    } catch (_) {
      hostUrl = null;
    }
    const aggregate = aggregateRuns(runs, { hostUrl });
    return {
      availability: 'available',
      source: 'langsmith',
      reason: null,
      message: runs.length ? null : 'No root traces were found in this time window.',
      project: projectName,
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
      'LangSmith analytics could not be reached. Check the tracing key, endpoint, project, and network access.'
    );
  }
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  DEFAULT_TRACE_LIMIT,
  MAX_TRACE_LIMIT,
  LANGSMITH_TIMEOUT_MS,
  normalizeOptions,
  normalizeRun,
  aggregateRuns,
  loadAnalytics,
};
