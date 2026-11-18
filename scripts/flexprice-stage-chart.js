#!/usr/bin/env node
// Stage the upstream FlexPrice Helm chart into a chart this repo can actually
// install from Artifact Registry, and record what was changed.
//
//   node scripts/flexprice-stage-chart.js --source <checkout>/internal/ee/infrastructure/helm/flexprice \
//                                         --out ./staged/flexprice --version 1.10.0+fleet.1
//
// `--source` is a checkout at the commit named by deploy/flexprice/VERSION, not
// a registry pull: `oci://ghcr.io/flexprice/charts/flexprice` answers 401 to an
// anonymous token request, so there is nothing to pull.
//
// Three edits, each one closing a gap that a `helm_release` cannot express:
//
//   1. dependencies stripped, Chart.lock dropped. The four subchart deps are
//      conditioned off in this values shape, but Helm refuses to install a chart
//      whose declared deps are not vendored. Deleting the block is what
//      scripts/flexprice-helm.js already does locally.
//   2. infra probes widened. templates/infra/*.yaml hardcode timeoutSeconds /
//      failureThreshold with NO values key, and a `set` block reaches values, not
//      templates. On a loaded node those are not slow answers but timeouts, and a
//      timeout restarts a healthy database mid-migration.
//   3. nodeSelector/tolerations injected into postgres, kafka and redis. Those
//      three templates expose no placement keys (clickhouse does), and the GKE
//      pool is tainted NoSchedule — a pod that neither selects nor tolerates it
//      stays Pending forever.
//
// The output is a directory, so `helm package` + `helm push` are the caller's
// job. What this script owns is the sha256: a patched chart is not the upstream
// chart, and that must be a recorded value rather than a property of whoever ran
// the build last.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

const SOURCE = flag('--source');
const OUT = flag('--out');
const CHART_VERSION = flag('--version');
const DRY = argv.includes('--dry-run');

if (!SOURCE || !OUT) {
  console.error('usage: flexprice-stage-chart.js --source <chart-dir> --out <dir> [--version <ver>] [--dry-run]');
  process.exit(2);
}
if (!fs.existsSync(path.join(SOURCE, 'Chart.yaml'))) {
  console.error(`no Chart.yaml under ${SOURCE} — point --source at internal/ee/infrastructure/helm/flexprice`);
  process.exit(2);
}

const PROBE_WIDEN = { timeoutSeconds: 20, failureThreshold: 6 };
const PROBE_FILES = ['postgres', 'kafka', 'clickhouse', 'redis'];
// The three that render a pod spec with no placement keys at all.
const PLACEMENT_FILES = ['postgres', 'kafka', 'redis'];
const PLACEMENT_BLOCK = [
  '      {{- with .Values.nodeSelector }}',
  '      nodeSelector:',
  '        {{- toYaml . | nindent 8 }}',
  '      {{- end }}',
  '      {{- with .Values.tolerations }}',
  '      tolerations:',
  '        {{- toYaml . | nindent 8 }}',
  '      {{- end }}',
];

const edits = [];
function note(file, what, count = 1) {
  edits.push({ file, what, count });
}

// --- 1. dependencies --------------------------------------------------------
function stripDependencies(yamlText) {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((l) => /^dependencies:\s*$/.test(l));
  if (start < 0) throw new Error('Chart.yaml has no `dependencies:` block — the chart changed shape and this script is now guessing');
  let end = start + 1;
  // A top-level key ends at the next line at indent 0 that is not blank.
  while (end < lines.length && (/^\s*$/.test(lines[end]) || /^\s/.test(lines[end]))) end++;
  const removed = lines.slice(start, end).filter((l) => /^\s*-\s+name:/.test(l)).length;
  if (removed !== 4) throw new Error(`expected 4 subchart dependencies, found ${removed}`);
  note('Chart.yaml', 'dependencies block removed', removed);
  return lines.slice(0, start).concat(lines.slice(end)).join('\n');
}

// --- 2. probes --------------------------------------------------------------
// Walk the probe blocks by indentation rather than by line number: a chart bump
// shifts lines, and a shift is exactly the case where a positional patch would
// silently widen the wrong field.
function relaxProbes(text, file) {
  const lines = text.split('\n');
  const out = [];
  let changed = 0;
  let added = 0;
  let blockIndent = null; // indent of the `livenessProbe:` / `readinessProbe:` key
  let sawTimeout = false;
  let blockAt = -1;

  const closeBlock = () => {
    // ClickHouse renders `failureThreshold` with no `timeoutSeconds` at all,
    // which means the kubelet default of 1s. Insert the key when a block was
    // complete and silent about it.
    if (blockIndent !== null && !sawTimeout && blockAt >= 0) {
      out.splice(blockAt + 1, 0, `${' '.repeat(blockIndent + 2)}timeoutSeconds: ${PROBE_WIDEN.timeoutSeconds}`);
      added++;
    }
    blockIndent = null;
    sawTimeout = false;
    blockAt = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const probe = /^(\s*)(livenessProbe|readinessProbe):\s*$/.exec(line);
    if (probe) {
      closeBlock();
      blockIndent = probe[1].length;
      sawTimeout = false;
      out.push(line);
      blockAt = out.length - 1;
      continue;
    }
    if (blockIndent !== null) {
      const indent = /^\s*/.exec(line)[0].length;
      if (line.trim() !== '' && indent <= blockIndent) {
        closeBlock();
      } else {
        const field = /^(\s*)(timeoutSeconds|failureThreshold):\s*(\d+)(.*)$/.exec(line);
        if (field) {
          if (field[2] === 'timeoutSeconds') sawTimeout = true;
          // The upstream inline comments ("Increased from 5") describe the value
          // they annotate, so they are replaced rather than kept beside a number
          // that no longer matches them.
          out.push(field[1] + field[2] + ': ' + PROBE_WIDEN[field[2]] + ' # fleet: was ' + field[3]);
          changed++;
          continue;
        }
      }
    }
    out.push(line);
  }
  closeBlock();
  if (changed === 0 && added === 0) throw new Error(`${file}: no probe timing found to widen — the chart changed and the fragile defaults are back`);
  note(file, `probe timings widened (${changed} set, ${added} inserted)`, changed + added);
  return out.join('\n');
}

// --- 3. placement -----------------------------------------------------------
// Anchor: the pod spec's `    spec:` line, which each of these templates
// introduces with a component label one line above. Anchoring on the label
// rather than the line number also makes a second insertion impossible: after
// the first pass the label line is followed by the injected block, not by
// `containers:`.
function injectPlacement(text, component) {
  const lines = text.split('\n');
  // The component label appears five times in these files (Service, Service head,
  // StatefulSet, selector, pod template). Only the pod template's is followed by
  // a 4-space `spec:`, so that pairing — not the label alone — is the anchor.
  const at = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => l.trim() === `app.kubernetes.io/component: ${component}` && /^ {4}spec:\s*$/.test(lines[i + 1] || ''));
  if (at.length !== 1) {
    throw new Error(`expected exactly one pod-spec anchor for ${component}, found ${at.length} — template shape changed`);
  }
  if (lines.some((l) => /^\s*nodeSelector:/.test(l))) {
    throw new Error(`${component} already renders a nodeSelector — re-derive this patch instead of stacking a second one`);
  }
  lines.splice(at[0].i + 2, 0, ...PLACEMENT_BLOCK);
  note(`templates/infra/${component}.yaml`, 'global nodeSelector/tolerations injected', PLACEMENT_BLOCK.length);
  return lines.join('\n');
}

// --- run --------------------------------------------------------------------
function readChart(dir) {
  const files = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(child);
      else files.set(child, fs.readFileSync(path.join(dir, child), 'utf8'));
    }
  };
  walk('');
  return files;
}

const files = readChart(SOURCE);

if (files.has('Chart.lock')) {
  files.delete('Chart.lock');
  note('Chart.lock', 'deleted (its deps no longer exist)');
}
files.set('Chart.yaml', stripDependencies(files.get('Chart.yaml')));
if (CHART_VERSION) {
  files.set('Chart.yaml', files.get('Chart.yaml').replace(/^version:\s*\S+\s*$/m, `version: ${CHART_VERSION}`));
  note('Chart.yaml', `version set to ${CHART_VERSION}`);
}

for (const component of PROBE_FILES) {
  const key = `templates/infra/${component}.yaml`;
  if (!files.has(key)) throw new Error(`missing ${key} in ${SOURCE}`);
  files.set(key, relaxProbes(files.get(key), key));
}
for (const component of PLACEMENT_FILES) {
  files.set(`templates/infra/${component}.yaml`, injectPlacement(files.get(`templates/infra/${component}.yaml`), component));
}

// Tree digest: sorted relative paths, each file's content hashed, then the
// manifest hashed. Order-independent w.r.t. the filesystem, sensitive to every
// byte of every template — which is the property a patched chart needs.
const digest = crypto.createHash('sha256');
for (const name of [...files.keys()].sort()) {
  digest.update(`${name}\0`);
  digest.update(crypto.createHash('sha256').update(files.get(name)).digest('hex'));
  digest.update('\0');
}
const sha256 = digest.digest('hex');

for (const e of edits) console.log(`  ${e.file}: ${e.what}`);
console.log(`chart sha256: ${sha256}`);

if (DRY) {
  console.log('[dry-run] nothing written');
  process.exit(0);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
for (const [name, content] of files) {
  const target = path.join(OUT, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
fs.writeFileSync(`${OUT}.sha256`, `${sha256}\n`);
console.log(`staged chart written to ${OUT}`);
