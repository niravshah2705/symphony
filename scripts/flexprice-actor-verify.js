#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const ROOT = path.resolve(__dirname, '..');

async function childMain() {
  const substrate = require('../packages/shared-core/src/agent/substrate');
  const { pbString } = require('../packages/shared-core/src/agent/grpc-wire');
  const { monitorActorSession } = require('../packages/shared-core/src/billing/actor-sessions');
  Object.assign(substrate, {
    resolveSubstrateAtespace: () => 'phase4-test',
    resolveSubstrateIngressUrl: () => 'http://127.0.0.1:1',
    ensureAtespace: async () => ({}), upsertActorTemplate: async () => ({}),
    createEphemeralActor: async () => ({ metadata: { name: process.env.ACTOR_VERIFY_ORG } }),
    createActorEgressPolicy: async () => ({}),
    getActorStatus: async () => ({ status: { state: 'RUNNING' } }),
    mintActorJwt: async () => ({ tokenPresent: true }),
    grpcCall: async () => ({ status: 0, firstFrame: pbString(1, 'test-jwt') }),
    suspendActor: async () => ({}), deleteActor: async () => ({}),
  });
  await require('../packages/shared-core/src/agent/substrate-runner').runPlanningOnSubstrate({
    organizationId: process.env.ACTOR_VERIFY_ORG, projectId: 'project-verify',
    userId: 'user-verify', userEmail: 'verify@test.invalid', prompt: 'isolated crash rehearsal',
    traceContext: { runId: 'run-verify' },
    fetchImpl: async () => new Promise(() => {}),
    actorSessionMonitor: (input, options) => {
      const monitor = monitorActorSession(input, { ...options, heartbeatMs: 1000 });
      process.send({ sessionId: monitor.session.id });
      return monitor;
    },
  });
}

async function waitFor(check, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('verification read-back deadline exceeded');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-actor-verify-'));
  process.env.AI_FLEET_DATA_DIR = dir;
  const orgId = `org-actor-verify-${Date.now().toString(36)}`;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'http://127.0.0.1:14319/v1/metrics';
  const prom = process.env.SUBSTRATE_PROMETHEUS_URL || 'http://127.0.0.1:19093';
  const { ACTOR_SESSION_METRICS } = require('../packages/shared-core/src/billing/substrate-session');
  const { createActorMetrics } = require('../packages/shared-core/src/otel/actor-metrics');
  let child;
  let checks = 0;
  function check(name, value, detail = '') {
    if (!value) throw new Error(`FAIL ${name}: ${detail}`);
    checks += 1;
    console.log(`ok ${name}${detail ? ` — ${detail}` : ''}`);
  }
  async function query(expression) {
    const url = new URL('/api/v1/query', prom);
    url.searchParams.set('query', expression);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    const body = await response.json();
    if (!response.ok || body.status !== 'success') throw new Error('Prometheus query failed');
    return body.data.result;
  }
  const selector = `{fleet_org_id=${JSON.stringify(orgId)}}`;
  try {
    console.log('Phase 4: real runner process + real OTLP/Prometheus/FlexPrice; substrate RPCs are stubbed, no gVisor actor is created.');
    await query('up');
    child = fork(__filename, ['--child'], {
      cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        AI_FLEET_DATA_DIR: dir, ACTOR_VERIFY_ORG: orgId,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
      },
    });
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(() => { throw new Error('runner exited before opening a session'); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('runner start deadline')), 10000); timer.unref(); }),
    ]);
    const live = await waitFor(async () => {
      const rows = await query(ACTOR_SESSION_METRICS.runningSeconds + selector);
      return rows.length && Number(rows[0].value[1]) >= 2 ? rows[0] : null;
    });
    check('live seconds accrue through OTLP and the scrape filter', Number(live.value[1]) >= 2, live.value[1]);
    for (const name of Object.values(ACTOR_SESSION_METRICS)) {
      const rows = await query(name + selector);
      check(`${name} carries org/tier/actor attributes`, rows.length === 1
        && rows[0].metric.fleet_org_id === orgId && rows[0].metric.substrate_tier === 'standard-1v1g'
        && rows[0].metric.agent_id === orgId);
    }
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    const [, signal] = await exited;
    check('the isolated runner was killed without STOP', signal === 'SIGKILL');
    child = null;
    const store = require('../packages/shared-core/src/store');
    const before = store.getActorSession(ready.sessionId);
    check('START and last-seen survive process death', before.status === 'RUNNING' && before.lastSeenAt > before.startedAt);
    await waitFor(async () => Math.floor(Date.now() / 1000) > before.lastSeenAt);
    const { sweepActorSessions } = require('../services/billing/src/actor-session-sweeper');
    const metrics = createActorMetrics({ endpoint });
    const result = await sweepActorSessions({ graceSeconds: 0, enabled: true, metrics });
    const closed = store.getActorSession(ready.sessionId);
    check('orphan closes at last-seen, never sweep time', result.settled === 1
      && closed.stoppedAt === before.lastSeenAt && closed.durationSeconds === before.lastSeenAt - before.startedAt,
    `duration=${closed.durationSeconds}s`);
    const again = await sweepActorSessions({ graceSeconds: 0, enabled: true, metrics });
    check('second sweep emits no duplicate usage', again.settled === 0
      && store.listUsageRecords().filter((r) => r.actorSessionId === ready.sessionId).length === 1);
    const row = store.listBillingOutboxRows().find((r) => r.actorSessionId === ready.sessionId);
    check('zero price still queues integer seconds with user/project attribution', row.quantitySeconds === closed.durationSeconds
      && row.userId === 'user-verify' && row.projectId === 'project-verify');
    check('actor compute costs zero paise', store.listUsageRecords()[0].costPaise === 0);
    await waitFor(async () => {
      const rows = await query(ACTOR_SESSION_METRICS.startTimestamp + selector);
      return rows.length && Number(rows[0].value[1]) === 0;
    });
    const final = await query(ACTOR_SESSION_METRICS.runningSeconds + selector);
    check('final scraped seconds equal frozen duration', Number(final[0].value[1]) === closed.durationSeconds);
    const panel = await require('../services/billing/src/savings-panel').readSavingsPanel({ orgId }, { baseUrl: prom });
    check('savings PromQL is read-only and zero priced', panel.available && panel.actors[0].actualSeconds === closed.durationSeconds
      && panel.actors[0].savings.netSavedPaise === 0);

    const stack = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'deploy/flexprice/.env'), 'utf8')
      .split('\n').map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
    const config = {
      enabled: true, baseUrl: stack.FLEXPRICE_BASE_URL || 'http://127.0.0.1:18080',
      environmentId: stack.FLEXPRICE_ENVIRONMENT_ID || '00000000-0000-0000-0000-000000000001',
      timeoutMs: 5000, keys: { ingest: stack.FLEXPRICE_API_KEY_INGEST, money: stack.FLEXPRICE_API_KEY_MONEY },
    };
    const client = require('../packages/shared-core/src/billing/flexprice-client').createFlexpriceClient({ config });
    await client.createCustomer({ external_id: orgId, name: orgId, address_line1: 'Not provided', address_country: 'IN' });
    const drain = require('../packages/shared-core/src/billing/outbox-drain');
    await drain.drainOnce({ enabled: true, client });
    await waitFor(async () => {
      await drain.drainOnce({ enabled: true, client });
      return store.listBillingOutboxRows()[0].status === 'verified';
    });
    check('FlexPrice actor-compute meter verifies exact integer seconds', store.listBillingOutboxRows()[0].status === 'verified');
    check('90 seconds at the test rate is exactly 12 paise', require('../packages/shared-core/src/billing/compute-pricing')
      .priceActorUsage({ durationSeconds: 90, hourlyRatePaise: 463 }).expectedPaise === 12);
    console.log(`${checks}/${checks} checks passed; org=${orgId}`);
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (!process.argv.includes('--keep')) fs.rmSync(dir, { recursive: true, force: true });
    else console.log(`Store retained at ${dir}`);
  }
}

(process.argv.includes('--child') ? childMain() : main()).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
