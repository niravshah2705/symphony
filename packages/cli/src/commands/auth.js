'use strict';

const fs = require('fs');
const { Writable } = require('stream');
const readline = require('readline');

const out = require('../output');
const credentials = require('../credentials');
const { createClient, resolveBaseUrl } = require('../client');

const summary = 'Log in (store an API token), check status, or log out';
const usage = `adlc auth — manage the stored API token (~/.adlc/credentials.json)

Usage:
  adlc auth login [--token-file <path>] [--no-verify] [--api <url>]
  adlc auth status [--verify] [--api <url>]
  adlc auth logout

The token is your gateway bearer (a Firebase ID token in firebase auth mode).
Provide it WITHOUT putting it on the command line:
  • --token-file <path>    read the token from a file (recommended)
  • pipe it on stdin:      cat token.txt | adlc auth login
  • $ADLC_TOKEN            used if set
  • otherwise you're prompted (input hidden)

Notes:
  - Stored 0600 in ~/.adlc (dir 0700). $ADLC_HOME overrides the directory.
  - Firebase ID tokens are short-lived (~1h) — re-run login when they expire.
  - Every command then sends this token automatically; $ADLC_TOKEN overrides it.`;

/** Read a secret from a TTY without echoing it (muted output stream). */
function promptSecret(query) {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(query);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(String(answer).trim());
    });
  });
}

/** Resolve the token to store: --token-file → piped stdin → $ADLC_TOKEN → prompt. */
async function resolveInputToken(flags) {
  if (typeof flags['token-file'] === 'string' && flags['token-file']) {
    return fs.readFileSync(flags['token-file'], 'utf8').trim();
  }
  if (!process.stdin.isTTY) {
    try {
      const piped = fs.readFileSync(0, 'utf8').trim();
      if (piped) return piped;
    } catch (_) {
      /* no stdin */
    }
  }
  if (process.env.ADLC_TOKEN) return String(process.env.ADLC_TOKEN).trim();
  if (process.stdin.isTTY) return promptSecret('Paste your gateway API token: ');
  return '';
}

async function login({ args }) {
  const { flags } = args;
  const apiUrl = resolveBaseUrl(flags);
  const token = await resolveInputToken(flags);
  if (!token) {
    throw new Error('No token provided. Use --token-file <path>, pipe it on stdin, or set $ADLC_TOKEN.');
  }

  let identity = null;
  if (!flags['no-verify']) {
    const probe = createClient({ baseUrl: apiUrl, token });
    let me;
    try {
      me = await probe.request('GET', '/api/auth/me');
    } catch (err) {
      if (err.status === 401) {
        throw new Error('The gateway rejected that token (401). Nothing saved. Pass --no-verify to store it anyway.');
      }
      throw new Error(`Could not verify the token against ${apiUrl}: ${err.message}. Pass --no-verify to store it anyway.`);
    }
    identity = { email: (me.user && me.user.email) || null, role: me.role || null };
  }

  credentials.save({ token, apiUrl, identity, savedAt: new Date().toISOString() });

  out.ok(`Saved token to ${credentials.credentialsPath()}`);
  out.kv('gateway', apiUrl);
  if (identity && identity.email) {
    out.kv('signed in as', `${identity.email} (${identity.role || '—'})`);
  } else if (identity) {
    out.kv('note', `gateway auth is disabled — token stored but not required (role ${identity.role || '—'})`);
  } else {
    out.warn('Stored without verification (--no-verify).');
  }
  out.line('  Firebase ID tokens expire ~1h; re-run `adlc auth login` when commands start returning 401.');
}

async function status({ args }) {
  const creds = credentials.load();
  if (!creds || !creds.token) {
    out.line('Not logged in. Run `adlc auth login`.');
    if (process.env.ADLC_TOKEN) out.warn('$ADLC_TOKEN is set and will be used regardless.');
    return;
  }

  out.heading('adlc auth');
  out.kv('file', credentials.credentialsPath());
  out.kv('token', credentials.mask(creds.token));
  out.kv('gateway', creds.apiUrl || '(default)');
  if (creds.identity && creds.identity.email) {
    out.kv('signed in as', `${creds.identity.email} (${creds.identity.role || '—'})`);
  }
  out.kv('saved at', creds.savedAt || '—');
  if (process.env.ADLC_TOKEN) out.warn('$ADLC_TOKEN is set and overrides the stored token.');

  if (args.flags.verify) {
    const client = createClient({ baseUrl: resolveBaseUrl(args.flags), token: process.env.ADLC_TOKEN || creds.token });
    try {
      const me = await client.request('GET', '/api/auth/me');
      out.ok(`Token valid — ${(me.user && me.user.email) || 'gateway auth disabled'} (${me.role || '—'})`);
    } catch (err) {
      out.error(`Token check failed: ${err.message}`);
    }
  }
}

function logout() {
  if (credentials.clear()) out.ok(`Removed ${credentials.credentialsPath()}`);
  else out.line('Nothing to remove (not logged in).');
}

async function run(ctx) {
  const sub = ctx.args._[0];
  if (sub === 'login') return login(ctx);
  if (sub === 'status' || !sub) return status(ctx);
  if (sub === 'logout') return logout(ctx);
  throw new Error(`Unknown auth subcommand "${sub}". Try: login | status | logout`);
}

module.exports = { summary, usage, run };
