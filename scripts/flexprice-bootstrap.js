#!/usr/bin/env node
// Phase 0 FlexPrice bootstrap: checkout -> secrets -> build -> up -> verify.
//
// Idempotent, `--dry-run` honest, and it never prints a credential. The raw API
// key exists in exactly two places: deploy/flexprice/.env (gitignored) and the
// API's key map as a hash. Echoing it would put a bearer credential for every
// org's money into shell history and into any log collector.
//
// Not a Phase 1 thing. It mints a super_admin key because that is the only kind
// FlexPrice will give a config-map key; the two-plane key split in
// docs/FLEXPRICE_FINDINGS.md §7 is Phase 1 work.

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const HERE = path.join(REPO_ROOT, 'deploy', 'flexprice');
const COMPOSE = path.join(HERE, 'compose.yaml');
const ENV_FILE = path.join(HERE, '.env');
const VERSION_FILE = path.join(HERE, 'VERSION');

const PINNED_COMMIT = readVersionField('commit');
const TENANT_ID = '00000000-0000-0000-0000-000000000000';
// The seeded Production environment, from migrations/postgres/V1__seed.sql
// (Sandbox is …000, Development-typed). Every FlexPrice data call needs
// X-Environment-ID, so a stack-level probe has to name one; this constant is
// seeded, not chosen, which is what makes it safe to hardcode.
const SEED_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_CHECKOUT = '/tmp/fp-research/flexprice';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

function readVersionField(key) {
  const text = fs.readFileSync(VERSION_FILE, 'utf8');
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`VERSION has no ${key}= field`);
  return line.slice(key.length + 1).trim();
}

function log(msg) { process.stderr.write(`${msg}\n`); }
function step(msg) { log(`\n== ${msg}`); }

function run(bin, argv, opts = {}) {
  if (DRY && !opts.always) {
    log(`  [dry-run] ${bin} ${argv.join(' ')}`.slice(0, 160));
    return { status: 0, stdout: '', stderr: '' };
  }
  const res = spawnSync(bin, argv, {
    encoding: 'utf8',
    cwd: opts.cwd || REPO_ROOT,
    env: opts.env || process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (VERBOSE && res.stdout) process.stdout.write(res.stdout);
  if (res.status !== 0 && !opts.allowFail) {
    const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
    throw new Error(`${bin} ${argv.join(' ')} failed (exit ${res.status})\n${out.slice(-4000)}`);
  }
  return res;
}

function compose(argv, opts = {}) {
  return run('docker', ['compose', '-f', COMPOSE, ...argv], opts);
}

// ---------------------------------------------------------------- 1. checkout

function ensureCheckout() {
  step(`1/6 FlexPrice checkout at ${PINNED_COMMIT.slice(0, 12)}`);
  const fromEnv = process.env.FLEXPRICE_CHECKOUT;
  const candidates = [fromEnv, DEFAULT_CHECKOUT].filter(Boolean);
  let dir = candidates.find((c) => fs.existsSync(path.join(c, 'Dockerfile')));

  if (!dir) {
    dir = path.join('/tmp', 'fp-checkout');
    if (!fs.existsSync(path.join(dir, '.git'))) {
      log(`  cloning flexprice/flexprice -> ${dir} (one-time, ~130 MB)`);
      run('git', ['clone', 'https://github.com/flexprice/flexprice.git', dir]);
    }
  }

  const head = run('git', ['-C', dir, 'rev-parse', 'HEAD'], { always: !DRY }).stdout.trim();
  if (!DRY && head && head !== PINNED_COMMIT) {
    log(`  checkout is at ${head.slice(0, 12)}, pinned is ${PINNED_COMMIT.slice(0, 12)} — fetching and detaching`);
    run('git', ['-C', dir, 'fetch', '--quiet', 'origin', PINNED_COMMIT]);
    run('git', ['-C', dir, 'checkout', '--quiet', '--detach', PINNED_COMMIT]);
  } else if (DRY) {
    log(`  [dry-run] would verify ${dir} is at ${PINNED_COMMIT.slice(0, 12)}`);
  }
  const describe = run('git', ['-C', dir, 'describe', '--tags', '--always'], { allowFail: true }).stdout.trim();
  log(`  ${dir} @ ${describe || 'unknown'}`);
  log('  note: this is 226 commits past v2.1.48 on main. VERSION says why (the');
  log('  findings cite file:line from this tree) and that Phase 1 must re-pin to a');
  log('  release tag and re-run the spike.');
  return dir;
}

// ------------------------------------------------------------------ 2. secrets

// Generated secrets are hex, not base64url, and that is not a style choice.
// base64url emits `-` and `_`, and a value beginning with `-` is eaten as a CLI
// flag: ClickHouse's /entrypoint.sh builds its `clickhouse-client` command with
// the password unquoted, so `-G9_…` died with
// `Unrecognized option '-G9_…' (UNRECOGNIZED_ARGUMENTS)` and the container exited
// before the API ever started. Hex is the smallest charset that is inert in a
// shell word, a URL, and a YAML scalar at the same time.
const hex = (n) => crypto.randomBytes(n).toString('hex');
const SECRET_KEYS = ['FLEXPRICE_PG_PASSWORD', 'FLEXPRICE_CH_PASSWORD', 'FLEXPRICE_AUTH_SECRET', 'FLEXPRICE_SECRETS_ENCRYPTION_KEY'];

// An .env is only reusable if it could have booted the stack. Two things a
// previously-generated .env can get wrong in a way that is not a typo:
//   - the role name. migrations/postgres/init-temporal-db.sh hardcodes
//     `GRANT ... TO flexprice`, so any other FLEXPRICE_PG_USER fails first boot
//     with postgres exit 3 and an error that points at postgres, not at the name.
//   - the secret charset (see hex above): a leading `-` is a CLI flag to
//     ClickHouse's entrypoint, which passes the password unquoted.
// Both are baked into an initialised data directory, so healing them means a new
// volume, not just a new file — hence regenerate-and-say-so rather than rewriting
// values in place, which would leave .env and the cluster disagreeing.
function reusable(env) {
  if (env.FLEXPRICE_PG_USER !== 'flexprice' || env.FLEXPRICE_CH_USER !== 'flexprice') return false;
  return SECRET_KEYS.every((k) => /^[0-9a-f]+$/.test(env[k] || ''));
}

function ensureEnv(checkout) {
  step('2/6 secrets and .env');
  const existing = fs.existsSync(ENV_FILE) ? parseEnv(ENV_FILE) : null;
  if (existing && reusable(existing) && !process.env.FLEXPRICE_REGENERATE_SECRETS) {
    log(`  reusing ${path.relative(REPO_ROOT, ENV_FILE)} (set FLEXPRICE_REGENERATE_SECRETS=1 for new keys)`);
    return existing;
  }
  if (existing) {
    log('  the existing .env cannot boot this stack (role name or secret charset); regenerating.');
    log('  run `npm run billing:flexprice:down` first — an initialised data directory keeps the');
    log('  old role and password, and initdb is first-boot-only, so the new values need a new volume.');
  }

  // The key is random but not secret-*stored*: only its sha256 goes into the API's
  // key map, which is how FlexPrice authenticates it. The raw value lives in .env
  // so our own client code can use it.
  const apiKey = `fp_local_${hex(24)}`;
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const keysJson = JSON.stringify({
    [keyHash]: {
      tenant_id: TENANT_ID,
      user_id: TENANT_ID,
      name: 'AI Fleet Phase 0 local',
      is_active: true,
    },
  });

  const env = {
    FLEXPRICE_CHECKOUT: checkout,
    // `flexprice`, not `fleet`. migrations/postgres/init-temporal-db.sh runs
    // `GRANT ALL PRIVILEGES ON DATABASE temporal TO flexprice` with the role name
    // hardcoded, so the superuser has to be called that or the first boot dies
    // (exit 3, "role does not exist") before the API ever starts. config.yaml's
    // own default is `user: flexprice` for the same reason. The password is
    // random; the *name* is part of the seed contract.
    FLEXPRICE_PG_USER: 'flexprice',
    FLEXPRICE_PG_PASSWORD: hex(18),
    FLEXPRICE_PG_DB: 'flexprice',
    FLEXPRICE_CH_USER: 'flexprice',
    FLEXPRICE_CH_PASSWORD: hex(18),
    FLEXPRICE_CH_DB: 'flexprice',
    FLEXPRICE_AUTH_SECRET: hex(32),
    FLEXPRICE_SECRETS_ENCRYPTION_KEY: hex(32),
    FLEXPRICE_ALLOW_INSECURE_DEFAULTS: 'false',
    FLEXPRICE_API_KEY: apiKey,
    FLEXPRICE_AUTH_API_KEY_KEYS: keysJson,
  };

  const body = [
    '# Generated by scripts/flexprice-bootstrap.js — gitignored, do not commit.',
    '# Local-only credentials for the Phase 0 billing spike.',
    '# FLEXPRICE_API_KEY is the raw key; the API stores only its sha256.',
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');
  if (DRY) {
    log('  [dry-run] would write .env with generated secrets (not printed)');
  } else {
    fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
    log(`  wrote ${path.relative(REPO_ROOT, ENV_FILE)} (mode 600, ${Object.keys(env).length} keys, no values echoed)`);
  }
  return env;
}

function parseEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ------------------------------------------------------- 3. build & 4. start

function build() {
  step('3/6 image build (Go; a few minutes the first time)');
  const has = run('docker', ['image', 'inspect', '-f', '{{.Id}}', 'flexprice-app:phase0'], { allowFail: true });
  if (has.status === 0 && has.stdout.trim() && !process.env.FLEXPRICE_REBUILD) {
    log(`  flexprice-app:phase0 already present (${has.stdout.trim().slice(7, 19)}...) — FLEXPRICE_REBUILD=1 to force`);
    return has.stdout.trim();
  }
  compose(['build', 'api']);
  const res = run('docker', ['image', 'inspect', '-f', '{{.Id}}', 'flexprice-app:phase0']);
  log(`  built ${res.stdout.trim().slice(7, 19)}`);
  return res.stdout.trim();
}

function up(env) {
  step('4/6 up: infra -> migrate -> api/consumer/worker');
  // In this order on purpose. `up -d` on the whole project waits on the migrate
  // one-shot through service_completed_successfully, and a first boot runs the
  // postgres initdb scripts (tenant seed + the temporal database) inside that
  // wait. Starting infra first makes the migration failure separable from an
  // infra failure, which is the difference between a useful log and a timeout.
  compose(['up', '-d', '--wait', 'postgres', 'kafka', 'clickhouse', 'redis', 'temporal'], { env: dockerEnv(env) });
  compose(['up', '-d', '--wait'], { env: dockerEnv(env) });
}

// Compose reads deploy/flexprice/.env itself only when the file sits next to the
// project file AND is named .env — which it is. We still pass the values through
// explicitly so `--env-file` differences between docker versions cannot change
// which key map the API boots with.
function dockerEnv(env) {
  return { ...process.env, ...env };
}

// ------------------------------------------------------------------ 5. verify

function healthUrl() { return 'http://127.0.0.1:18080/health'; }

async function verify(env) {
  step('5/6 verify');
  const verdicts = [];
  const note = (name, ok, detail) => {
    verdicts.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  if (DRY) {
    log('  [dry-run] would poll /health, list topics, check schema_migrations and wallets');
    return { ok: true, verdicts: ['dry-run'] };
  }

  // 1. readiness
  let health = null;
  for (let i = 0; i < 60 && !health; i += 1) {
    try {
      const res = await fetch(healthUrl(), { signal: AbortSignal.timeout(2000) });
      if (res.ok) health = await res.text();
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  note('api /health', Boolean(health), health ? health.slice(0, 60) : 'unreachable after 120s');

  // 2. the key map actually works — the cheapest proof that auth is wired to real
  //    secrets rather than bypassed by FLEXPRICE_ALLOW_INSECURE_DEFAULTS. Plus the
  //    three things only a live stack tells you (see findings §0.6/§7):
  //      - `/v1/tenants` is NOT a route in the OSS build (404 "404 page not
  //        found"), so it cannot be the auth probe. /v1/meters is.
  //      - every data call needs X-Environment-ID, and a key without it is refused
  //        403 "Invalid or inaccessible environment" rather than silently defaulted
  //        to one. That is the one scoping seam the key has, so it is asserted.
  //      - an unauthenticated read gets a real 401, so §7's "read RBAC is
  //        shadow-only" is about permissions *inside* a tenant, not about login.
  const authed = await apiGet('/v1/meters', env, SEED_ENVIRONMENT_ID);
  note('x-api-key + environment auth', authed.status === 200, `GET /v1/meters -> ${authed.status}`);

  const anon = await apiGet('/v1/meters', { FLEXPRICE_API_KEY: '' }, SEED_ENVIRONMENT_ID);
  note('rejects an unauthenticated read', anon.status === 401, `-> ${anon.status} ${anon.body.slice(0, 60)}`);

  const noEnv = await apiGet('/v1/meters', env, null);
  note('demands X-Environment-ID (the scoping seam)', noEnv.status === 403,
    `-> ${noEnv.status} ${noEnv.body.slice(0, 80)}`);

  const envs = await apiGet('/v1/environments', env, SEED_ENVIRONMENT_ID);
  const listed = (envs.body.match(/"id"/g) || []).length;
  note('both seeded environments readable', envs.status === 200 && listed >= 2, `environments=${listed}`);

  // 3. ingest plumbing present. `FLEXPRICE_KAFKA_TOPICS` FULLY REPLACES upstream's
  //    `kafka.topics` block (see deploy/flexprice/compose.yaml for why the names are
  //    load-bearing), so the created set is that JSON: the 11 upstream topics, the
  //    per-consumer-group DLQs, the two activity topics and the dotted analytics
  //    sink. The floor here is upstream's 11 + `events`, not an exact count: an
  //    operator may legitimately narrow the list, and a topic nobody asked for is
  //    not a failure. ◻ Activity *delivery* is unprobed — the spike never minted an
  //    activity consumer. See docs/FLEXPRICE_FINDINGS.md §9.
  const topics = run('docker', ['compose', '-f', COMPOSE, 'exec', '-T', 'kafka',
    'kafka-topics', '--bootstrap-server', 'kafka:9092', '--list'], { allowFail: true });
  const list = (topics.stdout || '').trim().split('\n').filter(Boolean);
  note('kafka topics', list.length >= 11 && list.includes('events'), `${list.length} topics, events=${list.includes('events')}`);

  // --database matters: clickhouse-client defaults to the `default` database, and
  // `currentDatabase()` there returns 0 tables for a ClickHouse whose 30-odd
  // flexprice tables are all present. A schema check that reports "empty" on a
  // healthy stack is worse than no check.
  const ch = run('docker', ['compose', '-f', COMPOSE, 'exec', '-T', 'clickhouse', 'clickhouse-client',
    `--user=${env.FLEXPRICE_CH_USER}`, `--password=${env.FLEXPRICE_CH_PASSWORD}`,
    `--database=${env.FLEXPRICE_CH_DB}`,
    '--query', 'SELECT count() FROM system.tables WHERE database=currentDatabase()'], { allowFail: true });
  note('clickhouse schema', Number(ch.stdout.trim() || 0) > 0, `${ch.stdout.trim()} tables in ${env.FLEXPRICE_CH_DB}`);

  const pg = run('docker', ['compose', '-f', COMPOSE, 'exec', '-T', 'postgres', 'psql',
    '-U', env.FLEXPRICE_PG_USER, '-d', env.FLEXPRICE_PG_DB, '-Atc',
    'SELECT count(*) FROM schema_migrations'], { allowFail: true });
  note('dbmate migrations recorded', Number(pg.stdout.trim() || 0) > 0, `${pg.stdout.trim()} rows`);
  if (!pg.stdout.trim()) log(`      psql said: ${(pg.stderr || '').split('\n').pop() || 'no output'}`);

  const seeded = run('docker', ['compose', '-f', COMPOSE, 'exec', '-T', 'postgres', 'psql',
    '-U', env.FLEXPRICE_PG_USER, '-d', env.FLEXPRICE_PG_DB, '-Atc',
    `SELECT count(*) FROM tenants WHERE id='${TENANT_ID}'`], { allowFail: true });
  note('default tenant seeded', seeded.stdout.trim() === '1', `tenants=${seeded.stdout.trim()}`);

  // 4. the containers that make usage queries work at all
  const ps = run('docker', ['compose', '-f', COMPOSE, 'ps', '--format', '{{.Service}} {{.State}}']);
  const running = (ps.stdout || '').trim().split('\n').filter((l) => /running|exited \(0\)/.test(l));
  for (const svc of ['consumer', 'worker']) {
    note(`${svc} up`, running.some((l) => l.startsWith(`${svc} `)), '');
  }

  return { ok: verdicts.every((v) => v.startsWith('OK')), verdicts };
}

async function apiGet(p, env, environmentId) {
  try {
    const headers = { 'x-api-key': env.FLEXPRICE_API_KEY, 'Content-Type': 'application/json' };
    if (environmentId) headers['X-Environment-ID'] = environmentId;
    const res = await fetch(`http://127.0.0.1:18080${p}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e.message) };
  }
}

// ------------------------------------------------------------------ 6. record

function record(imageId, env) {
  step('6/6 record what ran');
  if (DRY || !imageId) return;
  let text = fs.readFileSync(VERSION_FILE, 'utf8');
  text = text.replace(/^image=.*$/m, `image=${imageId}`);
  fs.writeFileSync(VERSION_FILE, text);
  log(`  VERSION image=${imageId.slice(7, 19)}...`);
  log(`  key hash recorded, raw key only in .env: ${path.relative(REPO_ROOT, ENV_FILE)}`);
  log('');
  log('next: npm run billing:flexprice:spike   (14 probes; pipeline-health first — if it fails, the rest measure the stack, not FlexPrice)');
  log('      npm run billing:flexprice:inspect (read back wallets/invoices/usage)');
  log('');
  log('to tear down: docker compose -f deploy/flexprice/compose.yaml down -v');
  log('  (-v matters: the tenant seed and the temporal database only run on an');
  log('   empty data directory, so `down` without -v restarts what you had.)');
}

(async function main() {
  const checkout = ensureCheckout();
  const env = ensureEnv(checkout);
  const imageId = build();
  up(env);
  const res = await verify(env);
  record(imageId, env);
  if (!res.ok) {
    log('\nbootstrap finished with failing checks; see docker compose logs api consumer worker');
    process.exitCode = 1;
  }
})().catch((e) => {
  log(`\nbootstrap failed: ${e.message}`);
  process.exitCode = 1;
});
