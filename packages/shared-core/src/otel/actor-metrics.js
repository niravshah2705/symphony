'use strict';

const { ACTOR_SESSION_METRICS, SESSION_RUNNING, accrue } = require('../billing/substrate-session');

function createActorMetrics({
  endpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
  log = console.warn,
} = {}) {
  let pending = Promise.resolve();

  function failed() {
    try { log?.('actor_metrics_export_failed'); } catch {}
    return false;
  }

  async function send(body) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('timeout'));
        }, timeoutMs);
      });
      const request = async () => {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
          redirect: 'error',
        });
        if (response.status < 200 || response.status >= 300) return false;
        const result = await response.json();
        if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
        return !(Number(result.partialSuccess?.rejectedDataPoints) > 0);
      };
      return await Promise.race([request(), timeout]) || failed();
    } catch {
      return failed();
    } finally {
      clearTimeout(timer);
    }
  }

  function emit(session, now = Date.now()) {
    if (!endpoint) return Promise.resolve(false);
    let body;
    try {
      const attributes = [
        ['fleet_org_id', session.orgId],
        ['substrate_tier', session.tier],
        ['agent_id', session.agentId],
      ];
      for (const [key, value] of [['project_id', session.projectId], ['user_id', session.userId]]) {
        if (value != null && String(value).trim()) attributes.push([key, value]);
      }
      const labels = attributes.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
      const timeUnixNano = (BigInt(Math.trunc(now)) * 1_000_000n).toString();
      const running = session.status === SESSION_RUNNING;
      const values = [running ? session.startedAt : 0, session.startedAt,
        running ? accrue(session, now) : session.durationSeconds];
      const metrics = Object.values(ACTOR_SESSION_METRICS).map((name, index) => ({
        name,
        gauge: { dataPoints: [{ attributes: labels, asDouble: values[index], timeUnixNano }] },
      }));
      // Snapshot before queuing: STOP or caller mutation must not rewrite an earlier heartbeat.
      body = JSON.stringify({ resourceMetrics: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'fleet-actor-sessions' } }] },
        scopeMetrics: [{ metrics }],
      }] });
    } catch {
      return Promise.resolve(failed());
    }
    pending = pending.then(() => send(body));
    return pending;
  }

  return { emit };
}

module.exports = { createActorMetrics };
