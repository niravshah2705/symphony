'use strict';

const out = require('../output');
const { follow } = require('../stream');

const summary = 'End-to-end: business → plan → issues → coder → PR';
const usage = `adlc run — drive the whole AI Fleet life cycle for one business/project

Steps: ensure a business + Linear project → ensure a role → enqueue planning and
wait for issues → start the coder board monitor → report.

Usage:
  adlc run --project <id> [options]
  adlc run --name <name> --new-project --team <teamId> [options]

Options:
  --project <id>        Use an existing Linear project id (skips business create)
  --name <name>         Business name (with --new-project, also the project name)
  --description <text>  Business/project description
  --new-project         Create a new Linear project for the business
  --team <teamId>       Team id (required with --new-project)
  --member <id>         Assume this member first if no role is set
  --no-code             Stop after planning (do not start the coder monitor)
  --timeout <s>         Max seconds to wait for planning to finish (default 900)
  --api <url>           Gateway base URL`;

const POLL_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensure a projectId: use --project, else create a business (optionally a project). */
async function ensureProject(client, flags) {
  if (typeof flags.project === 'string' && flags.project) {
    return { projectId: flags.project, business: null };
  }
  const name = typeof flags.name === 'string' ? flags.name : '';
  if (!name) throw new Error('Provide --project <id>, or --name to create a business.');

  const body = { name };
  if (typeof flags.description === 'string') body.description = flags.description;
  if (flags['new-project']) {
    if (typeof flags.team !== 'string') throw new Error('--team <teamId> is required with --new-project.');
    body.createNewProject = true;
    body.teamId = flags.team;
  }
  const { business } = await client.request('POST', '/api/businesses', body);
  out.ok(`Business "${business.name}" [${business.id}] → project ${business.projectId || 'unlinked'}`);
  if (!business.projectId) {
    throw new Error('Business has no linked project. Re-run with --new-project --team <id>, or link a project first.');
  }
  return { projectId: business.projectId, business };
}

/** Ensure a role is assumed; auto-assume --member if provided. */
async function ensureRole(client, flags) {
  const { assumedRole } = await client.request('GET', '/api/roles/assumed');
  if (assumedRole) return assumedRole;
  if (typeof flags.member === 'string' && flags.member) {
    const res = await client.request('PUT', '/api/roles/assumed', { id: flags.member });
    out.ok(`Assumed role: ${res.assumedRole.name || res.assumedRole.id}`);
    return res.assumedRole;
  }
  throw new Error('No role assumed. Run `adlc role list` then pass --member <id> (or `adlc role assume <id>`).');
}

/** Poll the job history until the newest job for projectId is terminal, or timeout. */
async function waitForPlanning(client, projectId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { jobs } = await client.request('GET', '/api/agent/jobs');
    const job = jobs.find((j) => j.projectId === projectId);
    if (job && (job.status === 'done' || job.status === 'error')) return job;
    if (Date.now() > deadline) return job || null;
    await sleep(POLL_MS);
  }
}

async function run({ client, args }) {
  const { flags } = args;
  const timeoutMs = (Number(flags.timeout) > 0 ? Number(flags.timeout) : 900) * 1000;

  out.heading('1/4 · Project');
  const { projectId } = await ensureProject(client, flags);

  out.heading('2/4 · Role');
  const role = await ensureRole(client, flags);
  out.kv('role', role.name || role.id);

  out.heading('3/4 · Planning');
  const enq = await client.request('POST', '/api/agent/enqueue', {
    projectId,
    projectName: typeof flags.name === 'string' ? flags.name : projectId,
  });
  out.ok(`Enqueued (conversation ${enq.conversationId}). Streaming steps…`);
  await follow(client, enq.conversationId, { maxMs: timeoutMs, idleMs: 30000 });
  const job = await waitForPlanning(client, projectId, timeoutMs);
  if (!job) {
    out.warn('No planning job observed yet — check `adlc jobs`.');
  } else if (job.status === 'error') {
    throw new Error(`Planning failed: ${job.error || 'unknown error'}`);
  } else if (job.status === 'done') {
    out.ok('Planning complete (project enriched with milestones + issues).');
  } else {
    out.warn(`Planning still ${job.status} after ${Math.round(timeoutMs / 1000)}s — continuing.`);
  }

  if (flags['no-code']) {
    out.heading('Done (planning only).');
    return;
  }

  out.heading('4/4 · Coder');
  const monitor = await client.request('POST', '/api/coder/monitor', { action: 'start' });
  out.ok(`Board monitor started (running: ${monitor.running}).`);
  // Give the monitor one poll cycle, then snapshot what it picked up.
  await sleep(POLL_MS);
  const status = await client.request('GET', '/api/coder');
  const inFlight = Array.isArray(status.inFlight) ? status.inFlight : [];
  out.kv('in-flight tickets', inFlight.length === 0 ? 0 : inFlight.map((t) => t.identifier).join(', '));

  out.heading('Summary');
  out.kv('project', projectId);
  out.kv('planning', job ? job.status : 'unknown');
  out.line('  The coder monitor now works issues to PRs in the background.');
  out.line('  Track it with: adlc monitor status   ·   adlc jobs');
}

module.exports = { summary, usage, run };
