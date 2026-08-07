'use strict';

const out = require('../output');

const summary = 'Gateway health + planner/coder readiness';
const usage = `adlc status — gateway health + planner and coder readiness

Usage: adlc status [--json] [--api <url>]`;

function roleName(role) {
  if (!role) return 'none';
  return role.name || role.id || 'unknown';
}

async function run({ client, args }) {
  const [health, agent, coder] = await Promise.all([
    client.request('GET', '/healthz').catch((err) => ({ error: err.message })),
    client.request('GET', '/api/agent/status').catch((err) => ({ error: err.message })),
    client.request('GET', '/api/coder').catch((err) => ({ error: err.message })),
  ]);

  if (args.flags.json) {
    return out.json({ gateway: client.base, health, agent, coder });
  }

  out.heading(`Gateway: ${client.base}`);
  out.kv('health', health && health.status ? health.status : `unreachable${health && health.error ? ` — ${health.error}` : ''}`);

  out.heading('Planner');
  if (agent.error) {
    out.kv('status', `error — ${agent.error}`);
  } else {
    out.kv('assumed role', roleName(agent.assumedRole));
    out.kv('LLM configured', agent.llmConfigured ? `yes (${agent.llmProvider || '?'} / ${agent.activeModel || '—'})` : 'no');
    out.kv('tracing', agent.tracingEnabled ? `on (${agent.langsmithProject || '—'})` : 'off');
    out.kv('enrich labels', (agent.enrichLabels || []).join(', '));
    out.kv('interval (min)', agent.intervalMinutes);
    out.kv('schedule enabled', agent.scheduleEnabled);
    out.kv('ticking now', agent.isTicking);
    if (agent.paused) out.kv('paused', agent.pauseReason && agent.pauseReason.message ? agent.pauseReason.message : true);
    if (agent.counts) {
      out.kv('jobs', `pending ${agent.counts.pending} · running ${agent.counts.running} · done ${agent.counts.done} · error ${agent.counts.error}`);
    }
  }

  out.heading('Coder');
  if (coder.error) {
    out.kv('status', `error — ${coder.error}`);
  } else {
    out.kv('monitor running', coder.running);
    out.kv('backend', coder.backend);
    out.kv('max concurrent', coder.maxConcurrent);
    if (coder.paused) out.kv('paused', coder.pauseReason && coder.pauseReason.message ? coder.pauseReason.message : true);
    const inFlight = Array.isArray(coder.inFlight) ? coder.inFlight : [];
    out.kv('in-flight', inFlight.length === 0 ? 0 : inFlight.map((t) => t.identifier).join(', '));
  }
}

module.exports = { summary, usage, run };
