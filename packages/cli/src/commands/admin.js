'use strict';

const fs = require('fs');
const out = require('../output');

const summary = 'Run direct, organization-scoped operator actions';
const usage = `adlc admin — trusted organization operator actions

Usage:
  adlc admin codex import --org-id <uuid> --settings-url <url> [--token-file <path>]
  adlc admin codex delete --org-id <uuid> --settings-url <url>
  adlc admin deploy approve --org-id <uuid> --settings-url <url>
    --run-id <id> --project-id <uuid> --repository <owner/name>
    --environment <name> [--expires-in-minutes <5-1440>]

Import reads a Codex auth JSON document from --token-file or stdin. It accepts
the normalized token bundle or Codex CLI's {tokens:{access_token,...}} shape.
The credential is sent directly to the IAM-gated settings service, encrypted in
the selected organization's vault, and is never saved or printed by this CLI.

Authentication uses the stored/$ADLC_TOKEN Firebase bearer. For an HTTPS Cloud
Run URL, Application Default Credentials mint the separate IAM ID token. Codex
mutations go directly to settings; deployment approval first reads scoped run
status through the gateway, then writes the exact tested lineage to settings.`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENVIRONMENT_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const GITHUB_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function jwtExpiry(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
  } catch (_) {
    return 0;
  }
}

function normalizeBundle(raw, now = Date.now()) {
  const document = raw && typeof raw === 'object' ? raw : {};
  const source = document.tokens && typeof document.tokens === 'object' ? document.tokens : document;
  const accessToken = String(source.accessToken || source.access_token || '').trim();
  const refreshToken = String(source.refreshToken || source.refresh_token || '').trim();
  if (!accessToken && !refreshToken) throw new Error('The Codex token document has no access or refresh token.');
  const expiresAt = Number(source.expiresAt || source.expires_at || jwtExpiry(accessToken) || now);
  const rawObtained = source.obtainedAt || source.obtained_at || document.last_refresh;
  const parsedObtained = typeof rawObtained === 'string' && !/^\d+$/.test(rawObtained)
    ? Date.parse(rawObtained)
    : Number(rawObtained);
  const obtainedAt = Number.isFinite(parsedObtained) && parsedObtained > 0 ? parsedObtained : now;
  return {
    accessToken,
    refreshToken,
    idToken: String(source.idToken || source.id_token || '').trim(),
    tokenType: String(source.tokenType || source.token_type || 'Bearer').trim(),
    scope: String(source.scope || 'openid profile email offline_access').trim(),
    expiresAt,
    obtainedAt,
  };
}

function readBundle(flags) {
  let text = '';
  if (typeof flags['token-file'] === 'string' && flags['token-file']) {
    text = fs.readFileSync(flags['token-file'], 'utf8');
  } else if (!process.stdin.isTTY) {
    text = fs.readFileSync(0, 'utf8');
  }
  if (!text.trim()) throw new Error('No token document provided. Use --token-file or pipe JSON on stdin.');
  try {
    return normalizeBundle(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The Codex token document is not valid JSON.');
    throw error;
  }
}

function operatorUrl(flags) {
  const raw = String(flags['settings-url'] || process.env.ADLC_SETTINGS_URL || '').trim();
  if (!raw) throw new Error('--settings-url (or $ADLC_SETTINGS_URL) is required.');
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Settings URL must use http or https.');
  const localHttp = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error('Settings URL must use HTTPS; plain HTTP is allowed only for loopback development.');
  }
  if (parsed.username || parsed.password) throw new Error('Settings URL must not contain credentials.');
  return parsed.toString().replace(/\/$/, '');
}

async function iamHeader(url) {
  if (!url.startsWith('https://')) return '';
  const { GoogleAuth } = require('google-auth-library');
  const audience = new URL(url).origin;
  const client = await new GoogleAuth().getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  if (typeof headers.get === 'function') return headers.get('authorization') || '';
  return headers.authorization || headers.Authorization || '';
}

async function requestOperator({
  client,
  flags,
  method,
  path = '/api/v1/operator/org/codex-tokens',
  body,
  fetchImpl = globalThis.fetch,
  iamHeaderImpl = iamHeader,
}) {
  const base = operatorUrl(flags);
  const orgId = String(flags['org-id'] || '').trim();
  if (!UUID_RE.test(orgId)) {
    throw new Error('--org-id must be a UUID.');
  }
  if (!client.token) throw new Error('A user token is required; run `adlc auth login` or set $ADLC_TOKEN.');
  const iam = await iamHeaderImpl(base);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-ai-fleet-organization-id': orgId,
  };
  if (iam) {
    headers.authorization = iam;
    headers['x-forwarded-authorization'] = `Bearer ${client.token}`;
  } else {
    headers.authorization = `Bearer ${client.token}`;
  }
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!response.ok) {
    const message = data && data.error && (data.error.message || data.error);
    throw new Error(message || `Settings service returned HTTP ${response.status}.`);
  }
  return data;
}

async function pendingDeploymentApproval({ client, flags, runId, projectId, repository, environment }) {
  const organizationId = String(flags['org-id'] || '').trim();
  const status = await client.request(
    'GET',
    `/api/pipeline/runs/${encodeURIComponent(runId)}`,
    undefined,
    {
      headers: {
        'x-ai-fleet-organization-id': organizationId,
        'x-ai-fleet-project-id': projectId,
      },
    },
  );
  const run = status && status.run;
  const pending = run && run.pendingDeploymentApproval;
  if (!run || run.runId !== runId || run.status !== 'awaiting_approval' || !pending) {
    throw new Error('The pipeline run is not awaiting a deployment approval.');
  }
  if (
    run.organizationId !== organizationId
    || run.projectId !== projectId
    || pending.runId !== runId
    || pending.projectId !== projectId
    || pending.repository !== repository
    || pending.environment !== environment
  ) {
    throw new Error('The requested deployment scope does not match the pending pipeline approval.');
  }
  if (
    !COMMAND_ID_RE.test(String(pending.testCommandId || ''))
    || !String(pending.testCommandId).startsWith(`${runId}:test:`)
    || !GITHUB_SHA_RE.test(String(pending.commitSha || ''))
    || !GITHUB_SHA_RE.test(String(pending.treeSha || ''))
    || !SHA256_RE.test(String(pending.preflightDecisionDigest || ''))
  ) {
    throw new Error('The pipeline returned an invalid deployment approval descriptor.');
  }
  return {
    testCommandId: pending.testCommandId,
    commitSha: pending.commitSha,
    treeSha: pending.treeSha,
    preflightDecisionDigest: pending.preflightDecisionDigest,
  };
}

async function run({ client, args }) {
  const [area, action] = args._;
  if (area === 'deploy' && action === 'approve') {
    const runId = String(args.flags['run-id'] || '').trim();
    const projectId = String(args.flags['project-id'] || '').trim();
    const repository = String(args.flags.repository || '').trim();
    const environment = String(args.flags.environment || '').trim().toLowerCase();
    const expires = args.flags['expires-in-minutes'] === undefined
      ? 240
      : Number(args.flags['expires-in-minutes']);
    if (!RUN_ID_RE.test(runId)) throw new Error('--run-id is invalid.');
    if (!UUID_RE.test(projectId)) {
      throw new Error('--project-id must be a UUID.');
    }
    if (!REPOSITORY_RE.test(repository)) {
      throw new Error('--repository must be a GitHub owner/name.');
    }
    if (!ENVIRONMENT_RE.test(environment)) throw new Error('--environment is invalid.');
    if (!Number.isInteger(expires) || expires < 5 || expires > 1440) {
      throw new Error('--expires-in-minutes must be an integer from 5 to 1440.');
    }
    const lineage = await pendingDeploymentApproval({
      client,
      flags: args.flags,
      runId,
      projectId,
      repository,
      environment,
    });
    await requestOperator({
      client,
      flags: args.flags,
      method: 'PUT',
      path: `/api/v1/operator/deployment-approvals/${encodeURIComponent(runId)}`,
      body: {
        projectId,
        repository,
        environment,
        ...lineage,
        expiresInMinutes: expires,
      },
    });
    out.ok(`Deployment approved for ${runId}. Resume the pipeline run to continue.`);
    return;
  }
  if (area !== 'codex' || !['import', 'delete'].includes(action)) {
    throw new Error('Unknown admin action. Try: adlc admin codex import|delete or adlc admin deploy approve');
  }
  if (action === 'import') {
    const tokens = readBundle(args.flags);
    await requestOperator({ client, flags: args.flags, method: 'PUT', body: { tokens } });
    out.ok('Codex credentials encrypted for the selected organization.');
    return;
  }
  await requestOperator({ client, flags: args.flags, method: 'DELETE' });
  out.ok('Codex credentials removed for the selected organization.');
}

module.exports = {
  summary,
  usage,
  run,
  _test: { jwtExpiry, normalizeBundle, operatorUrl, requestOperator, pendingDeploymentApproval },
};
