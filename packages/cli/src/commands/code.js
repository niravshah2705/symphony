'use strict';

const out = require('../output');
const { follow } = require('../stream');

const summary = 'Run the code-writer on one issue and follow progress';
const usage = `adlc code — run the code-writer deep agent on a single Linear issue

Drives the ticket end-to-end inside an isolated git clone to a pull request.

Usage: adlc code <issueId> [--no-follow] [--timeout <s>] [--api <url>]

Flags:
  --no-follow     Submit and print the conversationId without streaming steps
  --timeout <s>   Overall follow timeout in seconds (default 900)`;

async function run({ client, args }) {
  const issueId = args._[0];
  if (!issueId) throw new Error('An issueId is required: adlc code <issueId>');

  const res = await client.request('POST', '/api/coder/run', { issueId });
  const identifier = res.issue && res.issue.identifier ? res.issue.identifier : issueId;
  out.ok(`Coder dispatched for ${identifier}${res.conversationId ? ` (conversation ${res.conversationId})` : ''}`);

  if (args.flags['no-follow'] || !res.conversationId) return;

  out.heading('Live steps (Ctrl-C to detach):');
  const maxMs = Number(args.flags.timeout) > 0 ? Number(args.flags.timeout) * 1000 : undefined;
  await follow(client, res.conversationId, maxMs ? { maxMs } : {});
  out.line('\n(stream idle — check the Linear ticket / PR for the result)');
}

module.exports = { summary, usage, run };
