'use strict';

const out = require('../output');

const summary = 'Control the coder board monitor';
const usage = `adlc monitor — control the code-writer board monitor

Usage:
  adlc monitor status            Show monitor status + in-flight tickets
  adlc monitor start             Start the board monitor
  adlc monitor resume            Resume after a pause
  adlc monitor stop              Stop the board monitor

Flags: [--json] [--api <url>]`;

function printStatus(status, asJson) {
  if (asJson) return out.json(status);
  out.kv('running', status.running);
  out.kv('backend', status.backend);
  out.kv('max concurrent', status.maxConcurrent);
  if (status.paused) out.kv('paused', status.pauseReason && status.pauseReason.message ? status.pauseReason.message : true);
  const inFlight = Array.isArray(status.inFlight) ? status.inFlight : [];
  out.kv('in-flight', inFlight.length === 0 ? 0 : inFlight.map((t) => t.identifier).join(', '));
}

async function run({ client, args }) {
  const action = args._[0] || 'status';

  if (action === 'status') {
    const status = await client.request('GET', '/api/coder');
    return printStatus(status, args.flags.json);
  }

  if (action === 'start' || action === 'resume' || action === 'stop') {
    const status = await client.request('POST', '/api/coder/monitor', { action });
    out.ok(`Monitor ${action} → running: ${status.running}`);
    return printStatus(status, args.flags.json);
  }

  throw new Error(`Unknown monitor action "${action}". Try: status | start | resume | stop`);
}

module.exports = { summary, usage, run };
