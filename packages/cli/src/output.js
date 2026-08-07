'use strict';

/**
 * Plain stdout helpers. No color/table dependency (the repo ships none); a few
 * emoji match the style of scripts/models-label-group.js.
 */

const DASH = '—';

function line(message = '') {
  console.log(message);
}

function heading(message) {
  console.log(`\n${message}`);
}

/** Print a "  label: value" pair, rendering empty values as an em dash. */
function kv(label, value) {
  const shown = value === undefined || value === null || value === '' ? DASH : value;
  console.log(`  ${label}: ${shown}`);
}

function bullet(message) {
  console.log(`  • ${message}`);
}

function json(value) {
  console.log(JSON.stringify(value, null, 2));
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function warn(message) {
  console.log(`! ${message}`);
}

function error(message) {
  console.error(`✖ ${message}`);
}

module.exports = { line, heading, kv, bullet, json, ok, warn, error };
