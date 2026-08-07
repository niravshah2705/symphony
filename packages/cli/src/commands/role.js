'use strict';

const out = require('../output');

const summary = 'List / assume / clear the workspace role';
const usage = `adlc role — manage the assumed workspace role (required before planning)

Usage:
  adlc role list                 List assumable members
  adlc role assume <memberId>    Assume a member (validated server-side)
  adlc role clear                Drop the assumed role
  adlc role                      Show the currently assumed role

Flags: [--json] [--api <url>]`;

async function list({ client, args }) {
  const { members } = await client.request('GET', '/api/roles/members');
  if (args.flags.json) return out.json({ members });
  out.heading(`Assumable members (${members.length})`);
  for (const m of members) out.bullet(`${m.name || '(no name)'} — ${m.email || '—'}  [${m.id}]`);
}

async function assume({ client, args }) {
  const id = args._[1];
  if (!id) throw new Error('A member id is required: adlc role assume <memberId>');
  const { assumedRole } = await client.request('PUT', '/api/roles/assumed', { id });
  out.ok(`Assumed role: ${assumedRole.name || assumedRole.id} (${assumedRole.email || '—'})`);
}

async function clear({ client }) {
  await client.request('DELETE', '/api/roles/assumed');
  out.ok('Cleared the assumed role.');
}

async function show({ client, args }) {
  const { assumedRole } = await client.request('GET', '/api/roles/assumed');
  if (args.flags.json) return out.json({ assumedRole });
  out.kv('assumed role', assumedRole ? `${assumedRole.name || assumedRole.id} (${assumedRole.email || '—'})` : 'none');
}

async function run(ctx) {
  const sub = ctx.args._[0];
  if (sub === 'list') return list(ctx);
  if (sub === 'assume') return assume(ctx);
  if (sub === 'clear') return clear(ctx);
  if (!sub) return show(ctx);
  throw new Error(`Unknown role subcommand "${sub}". Try: list | assume <id> | clear`);
}

module.exports = { summary, usage, run };
