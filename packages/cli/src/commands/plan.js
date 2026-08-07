'use strict';

const out = require('../output');
const { follow } = require('../stream');

const summary = 'Enqueue planning for a project and follow progress';
const usage = `adlc plan — enqueue enrichment planning for a Linear project

Runs the planner deep agent: viability → business plan → milestones → issues.
Requires an assumed role (see: adlc role assume <memberId>).

Usage: adlc plan <projectId> [--name <projectName>] [--no-follow] [--api <url>]

Flags:
  --name <name>   Human label for the conversation (defaults to the project id)
  --no-follow     Submit and print the conversationId without streaming steps
  --timeout <s>   Overall follow timeout in seconds (default 900)`;

async function run({ client, args }) {
  const projectId = args._[0];
  if (!projectId) throw new Error('A projectId is required: adlc plan <projectId>');

  const body = { projectId };
  if (typeof args.flags.name === 'string') body.projectName = args.flags.name;

  const res = await client.request('POST', '/api/agent/enqueue', body);
  out.ok(`Planning enqueued for ${projectId} (conversation ${res.conversationId})`);

  if (args.flags['no-follow']) return;

  out.heading('Live steps (Ctrl-C to detach):');
  const maxMs = Number(args.flags.timeout) > 0 ? Number(args.flags.timeout) * 1000 : undefined;
  await follow(client, res.conversationId, maxMs ? { maxMs } : {});
  out.line('\n(stream idle — run `adlc jobs` for final status)');
}

module.exports = { summary, usage, run };
