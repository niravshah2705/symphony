#!/usr/bin/env node
'use strict';

/**
 * Dev/prod convenience runner: boot all three AI Fleet services as separate
 * child processes from a single terminal, with prefixed output and coordinated
 * shutdown. In a real microservice deployment each service runs in its own
 * container; this just makes local `npm start` behave like the old monolith.
 *
 * Pass --watch to run each service under `node --watch` (auto-restart on change),
 * matching the previous `npm run dev` behaviour.
 *
 *   node scripts/start-all.js
 *   node scripts/start-all.js --watch
 *
 * Env (PORT, PLANNER_PORT, CODER_SERVICE_PORT, CODER_*, etc.) is inherited by
 * every child, so a single repo-root .env configures the whole fleet.
 */

const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

// Start the agent services first so the gateway's proxy targets are likely up
// by the time the first browser request arrives (connections are lazy anyway).
const SERVICES = [
  { name: 'planner', entry: 'services/planner/src/index.js' },
  { name: 'coder', entry: 'services/coder/src/index.js' },
  { name: 'gateway', entry: 'services/gateway/src/index.js' },
];

const children = [];
let shuttingDown = false;

/**
 * Per-service env. In local (non-firestore) mode the worker services POST their
 * conversation events to the gateway's collector so SSE works across the three
 * processes; the gateway reads its own in-process bus (no self-sink).
 */
function envFor(name) {
  const env = { ...process.env };
  if (String(env.EVENTS_BACKEND || 'memory').toLowerCase() === 'firestore') return env;
  const gatewayPort = Number(env.PORT) || 4000;
  const sink = `http://localhost:${gatewayPort}/internal/events`;
  if (name === 'gateway') delete env.EVENTS_SINK_URL;
  else env.EVENTS_SINK_URL = env.EVENTS_SINK_URL || sink;
  return env;
}

function prefixStream(stream, name, sink) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) sink.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (buffer) sink.write(`[${name}] ${buffer}\n`);
  });
}

function startService({ name, entry }) {
  const args = watch ? ['--watch', entry] : [entry];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: envFor(name),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefixStream(child.stdout, name, process.stdout);
  prefixStream(child.stderr, name, process.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`[start-all] ${name} exited (code=${code} signal=${signal}); shutting down fleet.\n`);
    shutdown(code || 1);
  });
  children.push({ name, child });
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const service of SERVICES) startService(service);
process.stdout.write(`[start-all] started ${SERVICES.map((s) => s.name).join(', ')}${watch ? ' (watch mode)' : ''}\n`);
