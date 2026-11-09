#!/usr/bin/env node
'use strict';

/*
 * One-off maintenance: label usage records that predate BYOK metering.
 *
 * Every record written before `billingSource` existed WAS charged — the sweep
 * debited its `costPaise` and the ledger persisted that debit. So `managed` here
 * is a statement of fact, not a guess, and it is the only label that keeps the
 * records agreeing with the ledger. This script deliberately never touches money:
 * re-labelling a row to `customer` would claim the platform routed a payment it
 * actually made, and unwinding the charge is a ledger correction a human posts
 * after checking the org's own provider invoice.
 *
 *   node scripts/backfill-billing-source.js            # dry run — report only
 *   node scripts/backfill-billing-source.js --apply    # stamp the missing label
 */

const store = require('../packages/shared-core/src/store');

const APPLY = process.argv.includes('--apply');

function main() {
  const records = store.listUsageRecords();
  const unlabeled = records.filter((r) => !r.billingSource);
  const byOrg = new Map();
  for (const r of unlabeled) {
    const orgId = r.orgId || '(shared)';
    const acc = byOrg.get(orgId) || { count: 0, chargedPaise: 0, from: r.createdAt, to: r.createdAt };
    acc.count += 1;
    acc.chargedPaise += Number(r.costPaise) || 0;
    if (String(r.createdAt || '') < acc.from) acc.from = r.createdAt;
    if (String(r.createdAt || '') > acc.to) acc.to = r.createdAt;
    byOrg.set(orgId, acc);
  }

  console.log(`${records.length} usage record(s), ${unlabeled.length} without a billing source.`);
  if (!unlabeled.length) {
    console.log('Nothing to backfill.');
    return;
  }

  console.log('\nThese orgs would be labelled managed (money already debited for them):');
  for (const [orgId, acc] of [...byOrg.entries()].sort((a, b) => b[1].chargedPaise - a[1].chargedPaise)) {
    console.log(
      `  ${orgId}  ${acc.count} run(s)  ₹${(acc.chargedPaise / 100).toFixed(2)} charged  ` +
      `${String(acc.from || '').slice(0, 10)} → ${String(acc.to || '').slice(0, 10)}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to stamp ${unlabeled.length} record(s).`);
    return;
  }

  let stamped = 0;
  for (const record of unlabeled) {
    if (store.updateUsageRecord(record.id, { billingSource: 'managed' })) stamped += 1;
  }
  console.log(`\nStamped ${stamped} record(s) as managed. Records that already had a source were left alone.`);
  console.log(
    'If an organization says its own key paid for any of the runs above, correct the money in the ' +
    'ledger — do not re-label these rows.',
  );
}

try {
  main();
} catch (err) {
  console.error('backfill-billing-source failed:', err && err.message ? err.message : err);
  process.exit(1);
}
