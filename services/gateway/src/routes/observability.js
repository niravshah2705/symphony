'use strict';

const express = require('express');
const { getSettings } = require('@ai-fleet/shared/store');
const { asyncHandler } = require('@ai-fleet/shared/util');
const { loadAnalytics } = require('@ai-fleet/shared/agent/analytics');
const { runDiagnostics } = require('@ai-fleet/shared/agent/diagnostics');
const { catalog, validateWorkflowPattern } = require('@ai-fleet/shared/agent/workflow-patterns');

const router = express.Router();

function analyticsConfigured(result) {
  return !['tracing-disabled', 'api-key-missing', 'project-missing'].includes(result.reason);
}

// Prefer the actually-used names; fall back to the configured/available set.
function preferUsed(resources, usedKey, configuredKey) {
  const source = resources && typeof resources === 'object' ? resources : {};
  const used = source[usedKey];
  if (Array.isArray(used) && used.length) return used;
  return Array.isArray(source[configuredKey]) ? source[configuredKey] : [];
}

function toAnalyticsPayload(result) {
  const sourceSummary = result.summary || {};
  const traces = Array.isArray(result.traces) ? result.traces : [];
  return {
    configured: analyticsConfigured(result),
    availability: result.availability,
    reason: result.reason,
    message: result.message,
    window: result.window,
    summary: {
      traces: sourceSummary.traceCount || 0,
      totalCost: sourceSummary.totalCostUsd ?? null,
      inputTokens: sourceSummary.inputTokens ?? null,
      outputTokens: sourceSummary.outputTokens ?? null,
      totalTokens: sourceSummary.totalTokens ?? null,
      avgLatencyMs: sourceSummary.averageLatencyMs ?? null,
      errorRate: sourceSummary.errorRate ?? null,
      resourceUsage: sourceSummary.resourceUsage || { tools: [], skills: [], plugins: [] },
    },
    changes: traces.map((trace) => ({
      id: trace.id,
      name: trace.change && trace.change.label ? trace.change.label : trace.name,
      runtime: trace.runtime,
      model: trace.model,
      status: trace.status,
      startTime: trace.startedAt,
      latencyMs: trace.latencyMs,
      totalTokens: trace.tokens.total,
      totalCost: trace.cost.totalUsd,
      tools: preferUsed(trace.resources, 'toolsUsed', 'tools'),
      skills: preferUsed(trace.resources, 'skillsUsed', 'skills'),
      plugins: preferUsed(trace.resources, 'pluginsUsed', 'plugins'),
      traceUrl: trace.traceUrl,
    })),
    coverage: result.summary
      ? {
          cost: sourceSummary.costCoverage,
          tokens: sourceSummary.tokenCoverage,
          latency: sourceSummary.latencyCoverage,
        }
      : null,
  };
}

// Router is mounted at /api/observability by the gateway.
router.get('/analytics', asyncHandler(async (req, res) => {
  const result = await loadAnalytics(getSettings(), {
    hours: req.query && req.query.hours,
    limit: req.query && req.query.limit,
  });
  res.json(toAnalyticsPayload(result));
}));

router.get('/troubleshooting', asyncHandler(async (req, res) => {
  res.json(await runDiagnostics(getSettings()));
}));

router.get('/workflows', (req, res) => {
  res.json({ patterns: catalog() });
});

router.post('/workflows/validate', (req, res) => {
  const result = validateWorkflowPattern(req.body);
  res.status(result.valid ? 200 : 400).json(result);
});

module.exports = router;
module.exports.analyticsConfigured = analyticsConfigured;
module.exports.toAnalyticsPayload = toAnalyticsPayload;
