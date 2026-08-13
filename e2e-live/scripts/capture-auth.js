#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { chromium } = require('@playwright/test');

const { loadLiveConfig, parseStorageState } = require('../support/config');

function usage() {
  return [
    'Usage:',
    '  npm run e2e:auth:capture',
    '  npm run e2e:auth:capture -- --tenant a --output /secure/path/tenant-a.json',
  ].join('\n');
}

function parseCaptureArgs(argv) {
  let tenant = '';
  let output = '';
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--tenant') {
      tenant = String(argv[++index] || '').toLowerCase();
    } else if (argument.startsWith('--tenant=')) {
      tenant = argument.slice('--tenant='.length).toLowerCase();
    } else if (argument === '--output') {
      output = String(argv[++index] || '');
    } else if (argument.startsWith('--output=')) {
      output = argument.slice('--output='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (tenant && !['a', 'b'].includes(tenant)) throw new Error('--tenant must be a or b.');
  if (output && !tenant) throw new Error('--output requires --tenant a or --tenant b.');
  return Object.freeze({ tenant, output: output ? path.resolve(output) : '', help });
}

function atomicWriteStorageState(filename, state) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filename);
    if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* rename or cleanup already completed */ }
  }
  parseStorageState(filename, 'captured storage state');
}

async function verifySignedIn(page) {
  await page.locator('.auth-user').waitFor({ state: 'visible', timeout: 30_000 });
  const authorizedRequest = page.waitForRequest((request) => {
    try {
      return new URL(request.url()).pathname === '/api/auth/me'
        && /^Bearer\s+\S+$/i.test(request.headers().authorization || '');
    } catch (_) {
      return false;
    }
  }, { timeout: 30_000 });
  await page.evaluate(async () => {
    const auth = await import('/js/auth.js');
    const apiModule = await import('/js/api.js');
    await auth.ensureFreshToken();
    await apiModule.api.getCurrentUser();
  });
  await authorizedRequest;
}

async function captureTenant(browser, prompt, config, tenant, outputPath) {
  const label = `Tenant ${tenant.toUpperCase()}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
    stdout.write(`\n${label}: sign in manually with the dedicated synthetic QA identity.\n`);
    stdout.write('Select the intended organization and project in the application before continuing.\n');
    await prompt.question(`Press Enter only after ${label} is visibly signed in... `);
    await verifySignedIn(page);
    const state = await context.storageState({ indexedDB: true });
    atomicWriteStorageState(outputPath, state);
    stdout.write(`${label} browser state saved securely to ${outputPath}.\n`);
  } finally {
    await context.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseCaptureArgs(argv);
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Auth capture requires an interactive terminal for manual sign-in.');
  }
  const config = loadLiveConfig({
    requireAuth: false,
    requireAuthStates: false,
    requireDeploy: false,
    requireFixtures: false,
    requireTopology: false,
  });
  const captures = args.tenant
    ? [{ tenant: args.tenant, output: args.output || (args.tenant === 'a'
      ? config.authStateAPath : config.authStateBPath) }]
    : [
      { tenant: 'a', output: config.authStateAPath },
      { tenant: 'b', output: config.authStateBPath },
    ];
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    for (const capture of captures) {
      await captureTenant(browser, prompt, config, capture.tenant, capture.output);
    }
  } finally {
    prompt.close();
    await browser.close();
  }
  stdout.write('Capture complete. Treat each storage-state file as a live credential.\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Auth capture failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { atomicWriteStorageState, main, parseCaptureArgs, usage };
