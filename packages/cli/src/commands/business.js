'use strict';

const out = require('../output');

const summary = 'List / create businesses';
const usage = `adlc business — manage businesses (each backed by a Linear project)

Usage:
  adlc business list
  adlc business create --name <name> [options]

Create options:
  --name <name>            (required) Business name
  --description <text>     Business description
  --project <id>           Link an existing Linear project id
  --new-project            Create a new Linear project for the business
  --team <id>              Team id (required with --new-project)
  --project-name <name>    Name for the new project (defaults to --name)
  --repo <owner/name>      Default repository (e.g. acme/app)
  --provider <github|gitlab>  Repository provider (default github)

Flags: [--json] [--api <url>]`;

function printBusiness(b) {
  const project = b.project ? `${b.project.name || b.projectId}` : b.projectId || 'unlinked';
  out.bullet(`${b.name}  [${b.id}]  → project: ${project}${b.repo ? `  · repo: ${b.repo} (${b.repoProvider})` : ''}`);
}

async function list({ client, args }) {
  const { businesses } = await client.request('GET', '/api/businesses');
  if (args.flags.json) return out.json({ businesses });
  out.heading(`Businesses (${businesses.length})`);
  for (const b of businesses) printBusiness(b);
}

async function create({ client, args }) {
  const { flags } = args;
  const name = typeof flags.name === 'string' ? flags.name : '';
  if (!name) throw new Error('--name is required: adlc business create --name "My Business"');

  const body = { name };
  if (typeof flags.description === 'string') body.description = flags.description;
  if (typeof flags.project === 'string') body.projectId = flags.project;
  if (typeof flags.repo === 'string') body.repo = flags.repo;
  if (typeof flags.provider === 'string') body.repoProvider = flags.provider;
  if (flags['new-project']) {
    body.createNewProject = true;
    if (typeof flags.team !== 'string') throw new Error('--team <id> is required with --new-project.');
    body.teamId = flags.team;
    if (typeof flags['project-name'] === 'string') body.projectName = flags['project-name'];
  }

  const { business } = await client.request('POST', '/api/businesses', body);
  if (args.flags.json) return out.json({ business });
  out.ok(`Created business "${business.name}" [${business.id}]`);
  out.kv('project', business.projectId || 'unlinked');
}

async function run(ctx) {
  const sub = ctx.args._[0];
  if (sub === 'list' || !sub) return list(ctx);
  if (sub === 'create') return create(ctx);
  throw new Error(`Unknown business subcommand "${sub}". Try: list | create`);
}

module.exports = { summary, usage, run };
