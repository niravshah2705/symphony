#!/usr/bin/env node
'use strict';

/**
 * Dev/prod convenience runner: boot the local AI Fleet services as separate
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
 * Non-secret env (PORT, PLANNER_PORT, CODER_SERVICE_PORT, CODER_*, etc.) is
 * inherited by each child. Credentials are copied only into the process that
 * owns the corresponding capability.
 */

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');
// Direct-mode services have no Cloud Run IAM edge. Give the complete local
// fleet one ephemeral S2S credential when the operator did not configure one,
// preserving zero-config `npm start` without making internal routes public.
const localInternalToken = String(process.env.INTERNAL_API_TOKEN || '').trim()
  || crypto.randomBytes(32).toString('base64url');
// The stream-token secret is copied only into the dedicated broker process.
// Accepting an operator-provided value keeps Compose/manual local workflows
// stable; zero-config `npm start` still gets an ephemeral secret.
const localStreamSecret = String(process.env.STREAM_TOKEN_SECRET || '').trim()
  || crypto.randomBytes(32).toString('base64url');
const egressProxyPort = Number(process.env.LOCAL_EGRESS_PROXY_PORT) || 4030;
const streamTokenPort = Number(
  process.env.LOCAL_STREAM_TOKEN_PORT || process.env.LOCAL_STREAM_PROXY_PORT,
) || 4031;

const LOCAL_DEPENDENCIES = [
  { name: 'egress-proxy', entry: 'services/proxy/src/index.js', healthPort: egressProxyPort },
  {
    name: 'stream-token-broker',
    entry: 'services/proxy/src/stream-token-server.js',
    healthPort: streamTokenPort,
  },
];

// Start the agent services first so the gateway's proxy targets are likely up
// by the time the first browser request arrives (connections are lazy anyway).
const pipelineEnabled = String(process.env.PIPELINE_ORCHESTRATOR_ENABLED || '').trim().toLowerCase() === 'true';
const SERVICES = [
  { name: 'email', entry: 'services/email/src/index.js' },
  { name: 'planner', entry: 'services/planner/src/index.js' },
  { name: 'coder', entry: 'services/coder/src/index.js' },
  ...(pipelineEnabled ? [
    { name: 'tester', entry: 'services/tester/src/index.js' },
    { name: 'deployer', entry: 'services/deployer/src/index.js' },
    { name: 'orchestrator', entry: 'services/orchestrator/src/index.js' },
  ] : []),
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
  // Never copy ambient provider/stream credentials or the direct OpenSWE target
  // into application children. The settings service owns provider credentials;
  // only the appropriate proxy gets its scoped control or trusted target config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    key === 'FIREBASE_API_KEY'
    || (
      key !== 'OPENSWE_URL'
      && !/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(key)
    )
  )));
  env.INTERNAL_API_TOKEN = localInternalToken;
  if (name === 'egress-proxy') {
    env.PROXY_PORT = String(egressProxyPort);
    env.PROXY_CAPABILITIES = 'egress';
    env.PROXY_ORG_ID = String(process.env.PROXY_ORG_ID || process.env.FLEET_ORG_ID || '').trim();
    env.ORG_INTERNAL_API_TOKEN = String(process.env.ORG_INTERNAL_API_TOKEN || '').trim();
    env.SETTINGS_URL = process.env.SETTINGS_URL || 'http://127.0.0.1:8100';
    env.OLLAMA_PROXY_UPSTREAM = process.env.OLLAMA_PROXY_UPSTREAM
      || process.env.OLLAMA_HOST
      || 'http://127.0.0.1:11434';
    env.LMSTUDIO_PROXY_UPSTREAM = process.env.LMSTUDIO_PROXY_UPSTREAM
      || process.env.LMSTUDIO_HOST
      || 'http://127.0.0.1:1234';
    env.OMLX_PROXY_UPSTREAM = process.env.OMLX_PROXY_UPSTREAM
      || process.env.OMLX_HOST
      || 'http://127.0.0.1:8000';
    env.OPENSWE_PROXY_UPSTREAM = process.env.OPENSWE_PROXY_UPSTREAM
      || process.env.OPENSWE_URL
      || 'http://127.0.0.1:2024';
  } else if (name === 'stream-token-broker') {
    delete env.INTERNAL_API_TOKEN;
    env.PORT = String(streamTokenPort);
    env.STREAM_TOKEN_SECRET = localStreamSecret;
  } else if (name === 'gateway') {
    env.STREAM_TOKEN_SERVICE_URL = `http://127.0.0.1:${streamTokenPort}`;
  } else if (['planner', 'coder', 'tester', 'deployer'].includes(name)) {
    env.EGRESS_PROXY_URL = `http://127.0.0.1:${egressProxyPort}`;
  }
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
  return child;
}

function waitForHealth(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() >= deadline) return reject(new Error(`dependency health check on ${port} returned ${res.statusCode}`));
        setTimeout(probe, 100);
      });
      req.on('error', () => {
        if (Date.now() >= deadline) return reject(new Error(`dependency health check on ${port} timed out`));
        setTimeout(probe, 100);
      });
    };
    probe();
  });
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 500);
}

async function main() {
  for (const dependency of LOCAL_DEPENDENCIES) {
    startService(dependency);
    await waitForHealth(dependency.healthPort);
  }
  for (const service of SERVICES) startService(service);
  process.stdout.write(`[start-all] started ${[...LOCAL_DEPENDENCIES, ...SERVICES].map((s) => s.name).join(', ')}${watch ? ' (watch mode)' : ''}\n`);
}

if (require.main === module) {
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  main().catch((err) => {
    process.stderr.write(`[start-all] startup failed: ${err.message}\n`);
    shutdown(1);
  });
}

module.exports = { envFor, LOCAL_DEPENDENCIES, SERVICES };
