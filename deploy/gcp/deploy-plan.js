#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SERVICES = Object.freeze({
  gateway: Object.freeze({ id: 'gateway', image: 'gateway', dockerfile: 'deploy/gcp/Dockerfile.gateway', context: '.' }),
  planner: Object.freeze({ id: 'planner', image: 'planner', dockerfile: 'deploy/gcp/Dockerfile.planner', context: '.' }),
  coder: Object.freeze({ id: 'coder', image: 'coder-control', dockerfile: 'deploy/gcp/Dockerfile.coder', context: '.' }),
  orchestrator: Object.freeze({ id: 'orchestrator', image: 'pipeline-orchestrator', dockerfile: 'deploy/gcp/Dockerfile.orchestrator', context: '.' }),
  tester: Object.freeze({ id: 'tester', image: 'pipeline-tester', dockerfile: 'deploy/gcp/Dockerfile.tester', context: '.' }),
  deployer: Object.freeze({ id: 'deployer', image: 'pipeline-deployer', dockerfile: 'deploy/gcp/Dockerfile.deployer', context: '.' }),
  email: Object.freeze({ id: 'email', image: 'email-service', dockerfile: 'deploy/gcp/Dockerfile.email', context: '.' }),
  provisioner: Object.freeze({ id: 'provisioner', image: 'provisioner', dockerfile: 'deploy/gcp/Dockerfile.provisioner', context: '.' }),
  org: Object.freeze({ id: 'org', image: 'org-service', dockerfile: 'services/org/Dockerfile', context: 'services/org' }),
  settings: Object.freeze({ id: 'settings', image: 'settings-service', dockerfile: 'services/settings/Dockerfile', context: '.' }),
  proxy: Object.freeze({ id: 'proxy', image: 'proxy', dockerfile: 'deploy/gcp/Dockerfile.proxy', context: '.' }),
});

const startsWithAny = (value, prefixes) => prefixes.some((prefix) => value.startsWith(prefix));
const equalsAny = (value, candidates) => candidates.includes(value);

function classifyPaths(paths) {
  const changed = new Set();
  for (const file of paths) {
    if (startsWithAny(file, ['packages/shared/', 'packages/shared-core/'])) changed.add('shared');
    if (startsWithAny(file, ['services/gateway/']) || file === 'deploy/gcp/Dockerfile.gateway') changed.add('gateway');
    if (startsWithAny(file, ['services/planner/']) || file === 'deploy/gcp/Dockerfile.planner') changed.add('planner');
    if (startsWithAny(file, ['services/coder/']) || file === 'deploy/gcp/Dockerfile.coder') changed.add('coder');
    if (startsWithAny(file, ['services/orchestrator/']) || file === 'deploy/gcp/Dockerfile.orchestrator') changed.add('orchestrator');
    if (startsWithAny(file, ['services/tester/']) || file === 'deploy/gcp/Dockerfile.tester') changed.add('tester');
    if (startsWithAny(file, ['services/deployer/']) || file === 'deploy/gcp/Dockerfile.deployer') changed.add('deployer');
    if (startsWithAny(file, ['services/provisioner/']) || file === 'deploy/gcp/Dockerfile.provisioner') changed.add('provisioner');
    if (startsWithAny(file, ['services/proxy/']) || file === 'deploy/gcp/Dockerfile.proxy') changed.add('proxy');
    if (startsWithAny(file, ['services/org/'])) changed.add('org');
    if (startsWithAny(file, ['services/settings/'])) changed.add('settings');
    if (startsWithAny(file, ['services/email/']) || file === 'deploy/gcp/Dockerfile.email') changed.add('email');
    if (
      startsWithAny(file, ['public/']) ||
      equalsAny(file, [
        'firebase.json',
        'scripts/obfuscate-spa.js',
        'package.json',
        'package-lock.json',
        '.github/workflows/deploy.yml',
        'deploy/gcp/deploy.sh',
        'deploy/gcp/deploy-plan.js',
        'deploy/gcp/deploy-lib.sh',
      ])
    ) changed.add('spa');
    if (startsWithAny(file, ['deploy/gcp/terraform/'])) changed.add('infra');
    if (equalsAny(file, ['package.json', 'package-lock.json'])) changed.add('root');
  }
  return changed;
}

function createPlan(paths, { forceAll = false, pipelineEnabled = false } = {}) {
  const changed = classifyPaths(paths);
  const allNode = forceAll || changed.has('shared') || changed.has('root');
  const include = (id, condition) => (condition ? [SERVICES[id]] : []);
  const pipelineInfra = pipelineEnabled && changed.has('infra');

  let services = [
    ...include('gateway', allNode || changed.has('gateway')),
    ...include('planner', allNode || changed.has('planner')),
    ...include('coder', allNode || changed.has('coder')),
    ...include('orchestrator', allNode || changed.has('orchestrator') || pipelineInfra),
    ...include('tester', allNode || changed.has('tester') || pipelineInfra),
    ...include('deployer', allNode || changed.has('deployer') || pipelineInfra),
    ...include('email', allNode || changed.has('email')),
    ...include('provisioner', allNode || changed.has('provisioner')),
    ...include('org', forceAll || changed.has('org')),
    ...include('settings', allNode || changed.has('settings')),
  ];

  const spa = forceAll || changed.has('spa');
  const terraform = forceAll || changed.has('infra') || changed.has('proxy') || services.length > 0;
  if (terraform) services = [...services, SERVICES.proxy];

  return {
    changed: [...changed].sort(),
    services,
    spa,
    terraform,
  };
}

function changedPaths(repoRoot, since, sha) {
  const range = `${since}...${sha}`;
  const result = spawnSync('git', ['-C', repoRoot, 'diff', '--no-renames', '--name-only', '-z', range], {
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const reason = Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new Error(`unable to compare ${range}${reason ? `: ${reason}` : ''}`);
  }
  return Buffer.from(result.stdout || '')
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = { forceAll: false, pipelineEnabled: false, repoRoot: path.resolve(__dirname, '..', '..') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') args.forceAll = true;
    else if (arg === '--pipeline-enabled') args.pipelineEnabled = argv[(i += 1)] === 'true';
    else if (arg === '--since') args.since = argv[(i += 1)];
    else if (arg === '--sha') args.sha = argv[(i += 1)];
    else if (arg === '--repo') args.repoRoot = path.resolve(argv[(i += 1)]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.sha) throw new Error('--sha is required');
  if (!args.forceAll && !args.since) throw new Error('--since is required unless --all is used');
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const paths = args.forceAll ? [] : changedPaths(args.repoRoot, args.since, args.sha);
  const plan = createPlan(paths, args);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`deploy-plan: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = { SERVICES, classifyPaths, createPlan, changedPaths, parseArgs };
