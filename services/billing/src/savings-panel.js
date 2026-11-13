'use strict';

const { priceActorUsage, savingsEstimate } = require('@ai-fleet/shared-core/billing/compute-pricing');
const { ACTOR_SESSION_METRICS } = require('@ai-fleet/shared-core/billing/substrate-session');

const TIMEOUT_MS = 5000;
const WINDOW_UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const unavailable = (reason) => ({ available: false, reason });

function validateWindow(window) {
  const match = typeof window === 'string' && /^([1-9]\d{0,6})([smhdw])$/.exec(window);
  const seconds = match && Number(match[1]) * WINDOW_UNITS[match[2]];
  if (!seconds || seconds < 60 || seconds > 90 * 86400) {
    throw new TypeError('savingsPanel: window must be a duration between 1m and 90d');
  }
}

// Prometheus sample timestamps are scrape times, NOT first-seen times. Read
// only the sample value; require unique actor+tier keys even after aggregation.
function actorValues(payload) {
  if (payload?.status !== 'success' || payload.data?.resultType !== 'vector'
      || !Array.isArray(payload.data.result)) throw new Error('invalid vector');
  const values = new Map();
  for (const row of payload.data.result) {
    const agentId = row.metric?.agent_id;
    const tier = row.metric?.substrate_tier;
    const raw = row.value?.[1];
    if (typeof agentId !== 'string' || !agentId || typeof tier !== 'string' || !tier
        || !Array.isArray(row.value) || row.value.length !== 2
        || typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) {
      throw new Error('invalid actor sample');
    }
    const value = Number(raw);
    const key = JSON.stringify([agentId, tier]);
    if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER || values.has(key)) {
      throw new Error('invalid or duplicate actor sample');
    }
    values.set(key, { agentId, tier, value });
  }
  return values;
}

/**
 * Read-only counterfactual analytics: no ledger, outbox, debit or session write.
 * `now` is epoch seconds. `window` is a single Prometheus duration (1m..90d).
 * Only trusted dependencies/environment choose the upstream. D4 explicitly
 * prices actor compute at 0; an explicitly supplied missing/invalid rate is an
 * error, not another route to that default. No hourly-rate metric is queried.
 */
async function readSavingsPanel({ orgId, now = Date.now() / 1000, window = '30d' } = {}, deps = {}) {
  if (typeof orgId !== 'string' || !orgId.trim()) {
    throw new TypeError('savingsPanel: orgId is required');
  }
  if (orgId.trim() === '__shared__') return unavailable('shared organization is not attributable');
  validateWindow(window);
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
    throw new TypeError('savingsPanel: now must be finite epoch seconds');
  }
  const hourlyRatePaise = Object.hasOwn(deps, 'hourlyRatePaise') ? deps.hourlyRatePaise : 0;
  if (typeof hourlyRatePaise !== 'number' || !Number.isFinite(hourlyRatePaise)
      || hourlyRatePaise < 0 || hourlyRatePaise > Number.MAX_SAFE_INTEGER) {
    throw new TypeError('savingsPanel: hourlyRatePaise must be an explicit finite nonnegative number');
  }
  const baseUrl = deps.baseUrl ?? process.env.SUBSTRATE_PROMETHEUS_URL;
  if (!baseUrl) return unavailable('Prometheus is not configured');
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return unavailable('Prometheus reader is not available');

  try {
    const endpoint = new URL(baseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash) throw new Error('invalid configured URL');
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/api/v1/query`;
    const matcher = `{fleet_org_id=${JSON.stringify(orgId)}}`;
    // The running gauge retains FINAL session duration on close. Lookback keeps
    // closed actors visible after collector TTL; rate()/increase() would lose it.
    const queries = [
      `max by(agent_id,substrate_tier) (min_over_time(${ACTOR_SESSION_METRICS.firstSeenTimestamp}${matcher}[${window}]))`,
      `max by(agent_id,substrate_tier) (last_over_time(${ACTOR_SESSION_METRICS.runningSeconds}${matcher}[${window}]))`,
    ];
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const [firstSeen, running] = await Promise.all(queries.map(async (query) => {
      const url = new URL(endpoint);
      url.searchParams.set('query', query);
      url.searchParams.set('time', String(now));
      const response = await fetchImpl(url, { method: 'GET', signal, redirect: 'error' });
      if (!response.ok) throw new Error('Prometheus HTTP failure');
      return actorValues(await response.json());
    }));
    if (!firstSeen.size || !running.size) return unavailable('no actor data in lookback');
    if (firstSeen.size !== running.size) throw new Error('incomplete actor data');
    const actors = [];
    for (const [key, first] of firstSeen) {
      const actual = running.get(key);
      if (!actual || first.value > now || actual.value > Math.floor(now - first.value)) {
        throw new Error('inconsistent actor data');
      }
      const price = priceActorUsage({ durationSeconds: actual.value, tier: first.tier, hourlyRatePaise });
      const savings = savingsEstimate({
        firstSeenAt: first.value, now, billedSeconds: price.meterValue,
        billedPaise: price.expectedPaise, hourlyRatePaise,
      });
      if (!savings.available) throw new Error('unusable savings inputs');
      actors.push({
        agentId: first.agentId, tier: first.tier, firstSeenAt: first.value,
        baselineSeconds: savings.baselineSeconds, actualSeconds: price.meterValue,
        idleSeconds: savings.idleSeconds, price, savings,
      });
    }
    actors.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.tier.localeCompare(b.tier));
    return { available: true, orgId, now, window, hourlyRatePaise, actors };
  } catch {
    // Do not leak upstream details or replace an unavailable read with zeros.
    return unavailable('Prometheus actor data unavailable');
  }
}

module.exports = { readSavingsPanel };
