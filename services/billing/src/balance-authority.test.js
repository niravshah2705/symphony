'use strict';

/**
 * The money-authority grep gate (plan Phase 3: "grep gate finds no readable
 * first-party balance").
 *
 * FlexPrice's wallet is the only spendable balance in this product. That is only
 * true while nothing else holds a number that looks like one, and the way a second
 * balance comes back is quiet: someone stores `balancePaise` on the billing account
 * for convenience, a page reads it, the gate and the wallet disagree, and a tenant
 * is admitted or blocked on a figure no money ever moved. Three of those already
 * existed here and were deleted in Phase 3 (`ledger.balanceFromLedger`,
 * `billingAccounts.balancePaise`, the sweep's aggregated debit).
 *
 * So this is a source scan, not a behaviour test: there is no function left to call
 * that would produce the wrong number, which is exactly what it is asserting.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// Only shipped source: tests legitimately write the fields this forbids, in order
// to prove they are ignored. The e2e suites are in the scan because a stubbed or
// asserted response is a contract claim too — when it goes stale it says the old
// money model is still true, to whoever reads it next.
const SCAN_ROOTS = ['packages', 'services', 'public', 'scripts', 'e2e', 'e2e-live'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'docs', 'graphify-out', '.code-review-graph', 'test-data', 'dist']);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIR_NAMES.has(entry.name) ? [] : sourceFiles(absolute);
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) return [];
    if (entry.name.endsWith('.test.js') || absolute.includes(`${path.sep}public${path.sep}vendor${path.sep}`)) return [];
    return [absolute];
  });
}

const FILES = SCAN_ROOTS
  .map((root) => path.join(REPO_ROOT, root))
  .filter((dir) => fs.existsSync(dir))
  .flatMap(sourceFiles);

function matchesPerFile(predicate) {
  const hits = [];
  for (const file of FILES) {
    const source = fs.readFileSync(file, 'utf8');
    const found = predicate(source, file);
    if (found) hits.push(`${path.relative(REPO_ROOT, file)}: ${found}`);
  }
  return hits;
}

test('the scan actually covers the money code', () => {
  // A gate that silently stops matching files passes for the rest of its life, so
  // the file list is itself an assertion.
  const relative = FILES.map((file) => path.relative(REPO_ROOT, file));
  for (const expected of [
    'packages/shared-core/src/billing/gate.js',
    'packages/shared-core/src/billing/ledger.js',
    'packages/shared-core/src/billing/sweep.js',
    'services/billing/src/billing-api.js',
    'services/billing/src/auto-recharge-job.js',
    'services/billing/src/recharge-settle.js',
    'public/js/views/cost.js',
    'e2e/persistent-footer.spec.js',
    'e2e-live/scripts/audit.js',
  ]) {
    assert.ok(relative.includes(expected), `${expected} is not being scanned`);
  }
  assert.ok(FILES.length > 100, `only ${FILES.length} files scanned — the walker is broken`);
});

test('no account-shaped object carries a balance', () => {
  // `status.balancePaise` is fine and expected: that is the gate's wallet reading.
  // Anything named like the billing *account* is the stored document, and the
  // stored document has no balance field. `[\w$]` not `\w`: JS identifiers take $.
  const read = /(?:^|[^\w$])(?:account|acct|acc|existing|refreshed|stored|billingAccount|patch)\s*\.\s*balancePaise\b/;
  const violations = matchesPerFile((source) => {
    const hit = source.match(read);
    return hit ? hit[0] : null;
  });
  assert.deepEqual(violations, []);
});

test('nothing reads the ledger journal', () => {
  // `ledgerEntries` is a write-only developer trace since Phase 3. The moment
  // something reads it, a summed balance exists again — and a sum of local rows is
  // the number that used to disagree with the wallet in both directions.
  const ALLOWED = ['packages/shared-core/src/store.js'];
  const violations = matchesPerFile((source, file) => {
    if (ALLOWED.includes(path.relative(REPO_ROOT, file))) return null;
    const hit = source.match(/\blistLedgerEntries\s*\(/);
    return hit ? hit[0] : null;
  });
  assert.deepEqual(violations, []);
});

test('only the settle path may move credits in FlexPrice', () => {
  // One credit site, one debit site, one top-up path in the tooling. Anything else
  // that can add credits is a second way to fund a wallet without an intent — the
  // double-credit loop this repo had a "manual add credits" button for.
  const ALLOWED = [
    'packages/shared-core/src/billing/flexprice-client.js', // the transport itself
    'services/billing/src/recharge-settle.js', // quoted intent → credits, once
    'scripts/flexprice-provision.js', // operator bootstrap: FREE_CREDIT_GRANT
    'scripts/flexprice-phase1-probes.js', // contract probes, no product traffic
    'scripts/flexprice-spike/run.js', // the Phase 0 measurements the probes restate
  ];
  const offenders = new Set();
  for (const file of FILES) {
    const rel = path.relative(REPO_ROOT, file);
    if (ALLOWED.includes(rel)) continue;
    const hit = fs.readFileSync(file, 'utf8').match(/\.(?:topUpWallet|grantPromo|debitWallet)\s*\(/);
    if (hit) offenders.add(`${rel}: ${hit[0]}`);
  }
  assert.deepEqual([...offenders], []);
});

test('the deleted first-party money functions stay deleted', () => {
  const BANNED = ['postEntry', 'refreshBalance', 'balanceFromLedger', 'currentBalancePaise', 'maybeAutoRecharge'];
  const violations = matchesPerFile((source) => {
    const hit = source.match(new RegExp(`\\b(?:${BANNED.join('|')})\\b`));
    return hit ? hit[0] : null;
  });
  assert.deepEqual(violations, []);
});

test('the browser never does paise arithmetic', () => {
  // The SPA renders `balanceInr` / `fundState` from the billing API. A client-side
  // balance comparison is a second place the "is this org out of money" rule can
  // live, and it is the one that can be edited in devtools.
  const violations = matchesPerFile((source, file) => {
    if (!file.startsWith(path.join(REPO_ROOT, 'public'))) return null;
    const hit = source.match(/\bbalancePaise\b/);
    return hit ? hit[0] : null;
  });
  assert.deepEqual(violations, []);
});

test('nothing claims the deleted ledger route still exists', () => {
  // `GET /api/billing/ledger` was the browser's window onto the local journal. A
  // stub that still answers it keeps a test green against an endpoint no server
  // has, which is worse than a failure: it looks like coverage of a money path.
  const violations = matchesPerFile((source) => {
    const hit = source.match(/['"]\/api\/billing\/ledger|billing\.getLedger\b/);
    return hit ? hit[0] : null;
  });
  assert.deepEqual(violations, []);
});
