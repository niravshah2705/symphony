'use strict';

const out = require('../output');

const summary = 'Preview labelled projects the scheduler will enrich';
const usage = `adlc candidates — preview open projects the enrichment scheduler will pick up

Requires an assumed role (see: adlc role). Read-only.

Usage: adlc candidates [--json] [--api <url>]`;

async function run({ client, args }) {
  const { labels, projects } = await client.request('GET', '/api/agent/candidates');
  if (args.flags.json) return out.json({ labels, projects });
  out.heading(`Candidates for labels [${(labels || []).join(', ')}] (${projects.length})`);
  if (projects.length === 0) out.line('  (none — no open, labelled projects await enrichment)');
  for (const p of projects) {
    const progress = typeof p.progress === 'number' ? ` · ${Math.round(p.progress * 100)}%` : '';
    out.bullet(`${p.name}  [${p.id}]${progress}`);
  }
}

module.exports = { summary, usage, run };
