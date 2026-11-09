#!/usr/bin/env node
'use strict';

// Generates the Terraform input that mirrors the billing ledger's alert
// thresholds, so observability.tf can create one metric + alert per threshold
// WITHOUT restating the numbers in HCL.
//
//   node scripts/gen-observability-inputs.js          # write alert_thresholds.json
//   node scripts/gen-observability-inputs.js --check   # fail if it drifts (CI gate)
//
// The source of truth is DEFAULT_ALERT_THRESHOLDS_PAISE in
// packages/shared-core/src/billing/ledger.js. It is parsed from the source rather
// required, because ledger.js pulls in the store — this script has to run in CI
// with no Firestore, no credentials and no network.
//
// NOT a `.auto.tfvars.json`, even though Terraform would load that with no
// plumbing at all: deploy/gcp/terraform/.gitignore excludes `*.tfvars*` because
// those files are where an operator puts real secrets and state, so a committed
// generated input would either break that rule or never reach CI. Terraform reads
// this file through `jsondecode(file(...))` in observability.tf instead.

const fs = require('node:fs');
const path = require('node:path');

const LEDGER_PATH = path.resolve(__dirname, '../packages/shared-core/src/billing/ledger.js');
const OUT_PATH = path.resolve(__dirname, '../deploy/gcp/terraform/alert_thresholds.json');
const VARIABLE = 'billing_alert_thresholds_paise';

/** The integer paise list from `const DEFAULT_ALERT_THRESHOLDS_PAISE = Object.freeze([...])`. */
function readThresholds(source) {
  const decl = /const DEFAULT_ALERT_THRESHOLDS_PAISE\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]/.exec(source);
  if (!decl) throw new Error(`DEFAULT_ALERT_THRESHOLDS_PAISE not found in ${LEDGER_PATH}`);
  const values = decl[1]
    .split(',')
    .map((entry) => entry.replace(/\/\/.*/, '').trim())
    .filter(Boolean)
    .map((entry) => {
      if (!/^-?\d+$/.test(entry)) throw new Error(`threshold ${entry} is not an integer paise literal`);
      return Number(entry);
    });
  if (!values.length) throw new Error('DEFAULT_ALERT_THRESHOLDS_PAISE is empty');
  return values;
}

function serialize(thresholds) {
  // Hand-built rather than JSON.stringify(..., 2): the pretty printer puts one
  // threshold per line, and this file is read by humans diffing a billing change.
  return `{\n  "${VARIABLE}": [${thresholds.join(', ')}]\n}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const thresholds = readThresholds(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const output = serialize(thresholds);

  if (check) {
    const shipped = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
    if (shipped !== output) {
      console.error(`alert_thresholds.json is stale — run: npm run observability:inputs (${OUT_PATH})`);
      process.exit(1);
    }
    console.log(`alert_thresholds.json matches ledger.js (${thresholds.join(', ')} paise).`);
    return;
  }

  fs.writeFileSync(OUT_PATH, output);
  console.log(`Wrote ${OUT_PATH} (${thresholds.join(', ')} paise).`);
}

if (require.main === module) main();

module.exports = { readThresholds, serialize, VARIABLE, OUT_PATH, LEDGER_PATH };
