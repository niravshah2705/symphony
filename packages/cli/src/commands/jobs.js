'use strict';

const out = require('../output');

const summary = 'Show enrichment/coder job history';
const usage = `adlc jobs — planner enrichment job history

Usage: adlc jobs [--limit <n>] [--json] [--api <url>]`;

const DEFAULT_LIMIT = 20;

function statusMark(status) {
  if (status === 'done') return '✓';
  if (status === 'error') return '✖';
  if (status === 'running') return '…';
  return '·';
}

async function run({ client, args }) {
  const { jobs } = await client.request('GET', '/api/agent/jobs');
  const limit = Number(args.flags.limit) > 0 ? Number(args.flags.limit) : DEFAULT_LIMIT;
  const shown = jobs.slice(0, limit);

  if (args.flags.json) return out.json({ jobs: shown });

  out.heading(`Jobs (${shown.length} of ${jobs.length})`);
  if (shown.length === 0) out.line('  (no jobs yet)');
  for (const j of shown) {
    out.bullet(`${statusMark(j.status)} ${j.status.padEnd(7)} ${j.projectName || j.projectId}  [${String(j.id).slice(0, 8)}]${j.error ? `  — ${j.error}` : ''}`);
  }
}

module.exports = { summary, usage, run };
