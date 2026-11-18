#!/usr/bin/env node
'use strict';

/**
 * Record a published OCI digest in the catalogs, so the committed manifests can
 * be regenerated from it.
 *
 * The CI builders each write `<name>-oci-ref-<id>.txt` holding
 * `<image>@sha256:<digest>`. This script moves that digest into the catalog
 * record whose `image` matches — the one place a digest is stored — and the
 * manifests follow by `node scripts/gen-kagent-manifests.js`. The alternative,
 * sed-ing the digest into twelve YAML files, would leave the catalog and the
 * manifests as two sources of truth for the same bytes and make the drift check
 * circular.
 *
 * A digest is only ever written for the image the row names, so a stale artifact
 * from an earlier run cannot stamp a digest that belongs to different content:
 * the file name carries the id and the contents carry the repository, and both
 * must agree with the catalog row.
 *
 * Usage:
 *   node scripts/stamp-plugin-digest.js --refs-dir <dir>   write
 *   node scripts/stamp-plugin-digest.js --refs-dir <dir> --check   report only
 *
 * File names: plugin-oci-ref-<plugin>.txt, skill-oci-ref-<skill>.txt
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const registry = (name) => path.join(ROOT, 'packages/shared-core/src/agent/registry', name);
const CATALOG_JSON = registry('plugin-catalog.json');
const SKILL_JSON = registry('skill-catalog.json');

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
const CHECK = argv.includes('--check');
const refsDir = flag('--refs-dir');
if (!refsDir) {
  console.error('usage: stamp-plugin-digest.js --refs-dir <dir> [--check]');
  process.exit(1);
}
if (!fs.existsSync(refsDir)) {
  console.error(`no such refs dir: ${refsDir}`);
  process.exit(1);
}

const DIGEST_REF = /^(?<image>[^\s@]+)@(?<digest>sha256:[0-9a-f]{64})\s*$/;
const REF_FILE = /^(?<kind>plugin|skill)-oci-ref-(?<id>[a-z0-9][a-z0-9.-]*)\.txt$/;

/** Where a record of the given kind and id keeps its image + digest, or null. */
function locate(store, kind, id) {
  const list = kind === 'plugin' ? store.plugins : store.skills;
  const record = (list || []).find((r) => r && r.id === id);
  if (!record) return null;
  return kind === 'plugin' ? record.bundle : record.artifact;
}

/**
 * Rewrite one record's `"digest":` line in the file text.
 *
 * Line-oriented on purpose: re-serializing the catalog would reflow every entry
 * in it, so a digest write-back — the routine, machine-driven edit — would bury
 * the one line a reviewer needs to read inside a whole-file diff.
 */
function stampDigestInText(text, id, digest) {
  const lines = text.split('\n');
  let inRecord = false;
  let stamped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const idMatch = /^\s*"id":\s*"([^"]+)",?\s*$/.exec(lines[i]);
    if (idMatch) inRecord = idMatch[1] === id;
    if (!inRecord) continue;
    const dm = /^(\s*"digest":\s*)(?:"[^"]*"|null)(,?\s*)$/.exec(lines[i]);
    if (!dm) continue;
    lines[i] = `${dm[1]}"${digest}"${dm[2]}`;
    stamped += 1;
    inRecord = false;
    break;
  }
  if (stamped !== 1) throw new Error(`no single "digest" line found for ${id} — the record shape changed`);
  return lines.join('\n');
}

const changes = [];
const problems = [];
for (const file of fs.readdirSync(refsDir).sort()) {
  const named = REF_FILE.exec(file);
  if (!named) continue;
  const { kind, id } = named.groups;
  const raw = fs.readFileSync(path.join(refsDir, file), 'utf8').trim();
  const parsed = DIGEST_REF.exec(raw);
  if (!parsed) {
    problems.push(`${file}: "${raw}" is not <image>@sha256:<64 hex>`);
    continue;
  }
  const store = JSON.parse(fs.readFileSync(kind === 'plugin' ? CATALOG_JSON : SKILL_JSON, 'utf8'));
  const where = locate(store, kind, id);
  if (!where) {
    problems.push(`${file}: the ${kind} catalog has no "${id}" record to stamp`);
    continue;
  }
  if (where.image !== parsed.groups.image) {
    problems.push(`${file}: image ${parsed.groups.image} is not the catalog's ${where.image} for ${id}`);
    continue;
  }
  if (where.digest === parsed.groups.digest) continue;
  changes.push({ kind, id, file, digest: parsed.groups.digest, raw });
}

if (problems.length) {
  console.error(`ref artifacts rejected:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

if (CHECK && changes.length) {
  console.error(`catalogs are behind the published digests:\n  ${changes.map((c) => `${c.kind} ${c.id} -> ${c.digest}`).join('\n  ')}`);
  console.error('\nrun: node scripts/stamp-plugin-digest.js --refs-dir <dir> && node scripts/gen-kagent-manifests.js');
  process.exit(1);
}

// Apply the stamps to the file texts, one read and one write per catalog.
const touched = new Map();
for (const change of changes) {
  const target = change.kind === 'plugin' ? CATALOG_JSON : SKILL_JSON;
  const base = touched.get(target) || fs.readFileSync(target, 'utf8');
  touched.set(target, stampDigestInText(base, change.id, change.digest));
  console.log(`${CHECK ? 'would stamp' : 'stamped'} ${change.kind} ${change.id} = ${change.digest}`);
}
for (const [target, text] of touched) {
  if (!CHECK) fs.writeFileSync(target, text);
}
if (!changes.length) console.log('every published digest is already recorded');
else if (!CHECK) console.log(`stamped ${changes.length} digest(s); regenerate the manifests with: node scripts/gen-kagent-manifests.js`);
