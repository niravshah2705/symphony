#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'deploy', 'flexprice', 'VERSION');
const RESULTS_FILE = path.join(ROOT, 'docs', 'flexprice-spike', 'results.json');
const CONTRACT_TEST = path.join(ROOT, 'scripts', 'flexprice-spike', 'fleet_zoho_contract_test.go');
const CHECKOUT = path.resolve(process.env.FLEXPRICE_CHECKOUT || '/tmp/fp-research/flexprice');
const TEST_NAME = 'TestFleetGrossGSTInvoiceContract';

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return (result.stdout || '').trim();
}

function parseVersion(text) {
  const fields = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split > 0) fields[line.slice(0, split)] = line.slice(split + 1);
  }
  if (!/^[0-9a-f]{40}$/.test(fields.commit || '')) fail('deploy/flexprice/VERSION has no full commit pin');
  if (!fields.ref) fail('deploy/flexprice/VERSION has no ref pin');
  return fields;
}

function asNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`Probe C ${label} is not numeric: ${value}`);
  return number;
}

function validateProbeC(results) {
  const probe = results.results?.find((entry) => entry.item === 'C' && entry.name === 'gst-lands-in-invoice-total');
  if (!probe?.ok) fail('recorded Probe C is absent or unsuccessful');
  const gross = probe.observed?.priced_lines_gross_subtotal;
  if (!gross) fail('recorded Probe C has no priced gross-subtotal result');
  const amounts = gross.lines?.map((line) => asNumber(line.amount, 'line amount')) || [];
  const expected = [500, 45, 45];
  if (asNumber(gross.total, 'total') !== 590
      || asNumber(gross.subtotal, 'subtotal') !== 590
      || asNumber(gross.total_tax, 'total_tax') !== 0
      || amounts.length !== expected.length
      || amounts.some((amount, index) => amount !== expected[index])) {
    fail(`recorded Probe C contract changed: total=${gross.total}, subtotal=${gross.subtotal}, total_tax=${gross.total_tax}, lines=${amounts.join('+')}`);
  }
  console.log('ok Probe C records gross 590, total_tax 0, and lines 500+45+45');
}

function main() {
  if (process.env.ZOHO_MODE !== 'fake') fail('ZOHO_MODE=fake is required; live Zoho execution is forbidden');

  const version = parseVersion(fs.readFileSync(VERSION_FILE, 'utf8'));
  validateProbeC(JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')));

  if (!fs.statSync(CHECKOUT, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`pinned FlexPrice checkout not found: ${CHECKOUT}`);
  }
  run('git', ['-C', CHECKOUT, 'cat-file', '-e', `${version.commit}^{commit}`]);
  const head = run('git', ['-C', CHECKOUT, 'rev-parse', 'HEAD']);
  if (head !== version.commit) fail(`FlexPrice checkout HEAD ${head} does not match pinned commit ${version.commit}`);
  const refCommit = run('git', ['-C', CHECKOUT, 'rev-parse', `${version.ref}^{commit}`]);
  if (refCommit !== version.commit) fail(`FlexPrice ref ${version.ref} resolves to ${refCommit}, not ${version.commit}`);
  console.log(`ok checkout HEAD and ${version.ref} match ${version.commit}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-zoho-contract-'));
  const worktree = path.join(tempRoot, 'flexprice');
  let added = false;
  try {
    run('git', ['-C', CHECKOUT, 'worktree', 'add', '--detach', worktree, version.commit]);
    added = true;
    const target = path.join(worktree, 'internal', 'integration', 'zoho', path.basename(CONTRACT_TEST));
    fs.copyFileSync(CONTRACT_TEST, target);

    const env = { ...process.env, ZOHO_MODE: 'fake', GOTOOLCHAIN: 'local' };
    for (const name of Object.keys(env)) {
      if (/^ZOHO_/.test(name) && name !== 'ZOHO_MODE') delete env[name];
    }
    run('go', ['test', './internal/integration/zoho', '-run', `^${TEST_NAME}$`, '-count=1'], {
      cwd: worktree,
      env,
      stdio: 'inherit',
    });
    console.log(`ok ${TEST_NAME} passed at pinned FlexPrice commit`);
  } finally {
    if (added) {
      const removed = spawnSync('git', ['-C', CHECKOUT, 'worktree', 'remove', '--force', worktree], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      if (removed.status !== 0) {
        console.error(`warning: failed to remove temporary worktree ${worktree}: ${(removed.stderr || '').trim()}`);
        process.exitCode = 1;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`flexprice-zoho-contract: ${error.message}`);
  process.exitCode = 1;
}
