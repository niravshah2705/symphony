#!/usr/bin/env node
'use strict';

/**
 * adlc — command-line client for the AI Fleet life cycle.
 *
 * A thin HTTP client to the running gateway (the only intended client-facing
 * origin). Boot the fleet first with `npm start`. In firebase auth mode, set
 * ADLC_TOKEN in the environment (never passed as a flag, so it can't leak into
 * shell history or `ps`).
 *
 *   adlc status
 *   adlc role assume <memberId>
 *   adlc plan <projectId>
 *   adlc run --name "OTA" --new-project --team <teamId>
 */

const commands = require('../src/commands');
const { parseArgs } = require('../src/args');
const { createClient, resolveBaseUrl, resolveToken } = require('../src/client');
const out = require('../src/output');

function topUsage() {
  const lines = [
    'adlc — drive the AI Fleet life cycle (business → plan → issues → coder → PR)',
    '',
    'Usage: adlc <command> [args] [--flags]',
    '',
    'Commands:',
  ];
  const width = Math.max(...Object.keys(commands).map((n) => n.length));
  for (const [name, mod] of Object.entries(commands)) {
    lines.push(`  ${name.padEnd(width)}  ${mod.summary || ''}`);
  }
  lines.push(
    '',
    'Global flags:',
    '  --api <url>   Gateway base URL (default $ADLC_API_URL or http://localhost:4000)',
    '  --json        Print raw JSON where supported',
    '  -h, --help    Show help (top-level, or `adlc <command> --help`)',
    '',
    'Auth: set ADLC_TOKEN when the gateway runs in firebase mode.'
  );
  return lines.join('\n');
}

async function main() {
  const [, , command, ...rest] = process.argv;

  if (!command || command === 'help' || command === '-h' || command === '--help') {
    out.line(topUsage());
    return;
  }

  const handler = commands[command];
  if (!handler) {
    out.error(`Unknown command: ${command}`);
    out.line('');
    out.line(topUsage());
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(rest);
  if (args.flags.help || args.flags.h) {
    out.line(handler.usage || `No usage available for "${command}".`);
    return;
  }

  const client = createClient({ baseUrl: resolveBaseUrl(args.flags), token: resolveToken() });
  await handler.run({ client, args });
}

main().catch((err) => {
  out.error(err && err.message ? err.message : String(err));
  if (err && err.hint) out.line(`  ${err.hint}`);
  process.exit(1);
});
