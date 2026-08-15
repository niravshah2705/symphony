'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PIPELINE_STAGES = Object.freeze(['plan', 'code', 'test', 'deploy']);
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const SECRET_TEXT = /(?:bearer\s+)?(?:eyJ[A-Za-z0-9._-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/gi;

function boundedSafeText(value, max = 1_000) {
  return String(value || '')
    .replace(SECRET_TEXT, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function contextHeaders(token, organizationId, projectId) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-ai-fleet-organization-id': organizationId,
    'x-ai-fleet-project-id': projectId,
  };
}

async function jsonRequest(baseUrl, pathname, {
  method = 'GET',
  token,
  organizationId,
  projectId,
  body,
  expectedStatuses = [200],
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = new URL(pathname, `${String(baseUrl).replace(/\/+$/, '')}/`);
  const origin = new URL(baseUrl).origin;
  if (target.origin !== origin || !target.pathname.startsWith('/api/')) {
    throw new Error('QA API requests must remain on the selected gateway /api origin.');
  }
  const response = await fetchImpl(target.href, {
    method,
    headers: contextHeaders(token, organizationId, projectId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }
  if (!expectedStatuses.includes(response.status)) {
    const message = payload && payload.error;
    const detail = typeof message === 'string'
      ? message
      : message && typeof message.message === 'string'
        ? message.message
        : `HTTP ${response.status}`;
    const error = new Error(`QA API request ${method} ${pathname} failed: ${boundedSafeText(detail)}`);
    error.status = response.status;
    error.code = payload && (payload.code || (payload.error && payload.error.code));
    throw error;
  }
  return { status: response.status, data: payload };
}

async function freshBrowserBearer(page) {
  const requestPromise = page.waitForRequest((request) => {
    if (!request.url().includes('/api/auth/me')) return false;
    return /^Bearer\s+\S+$/i.test(request.headers().authorization || '');
  }, { timeout: 20_000 });
  await page.evaluate(async () => {
    const auth = await import('/js/auth.js');
    const apiModule = await import('/js/api.js');
    await auth.ensureFreshToken();
    await apiModule.api.getCurrentUser();
  });
  const request = await requestPromise;
  const authorization = request.headers().authorization || '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token || token === authorization) throw new Error('The browser did not provide a Firebase bearer token.');
  return { token, apiBaseUrl: new URL(request.url()).origin };
}

async function setEvidenceHud(page, title, lines = []) {
  const safeTitle = boundedSafeText(title, 120);
  const safeLines = lines.map((line) => boundedSafeText(line, 180)).slice(0, 8);
  await page.evaluate(({ heading, values }) => {
    let hud = document.querySelector('[data-e2e-evidence-hud]');
    if (!hud) {
      hud = document.createElement('aside');
      hud.dataset.e2eEvidenceHud = 'true';
      hud.setAttribute('aria-live', 'polite');
      Object.assign(hud.style, {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
        width: 'min(420px, calc(100vw - 40px))', padding: '16px',
        borderRadius: '12px', border: '1px solid rgba(255,255,255,.22)',
        background: 'rgba(13,18,30,.94)', color: '#f8fafc',
        font: '14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
        boxShadow: '0 12px 35px rgba(0,0,0,.35)', whiteSpace: 'pre-wrap',
      });
      document.body.appendChild(hud);
    }
    hud.textContent = [`E2E EVIDENCE — ${heading}`, ...values].join('\n');
  }, { heading: safeTitle, values: safeLines });
}

function latestStageRuns(status) {
  const latest = new Map();
  for (const stageRun of Array.isArray(status && status.stages) ? status.stages : []) {
    if (!stageRun || !PIPELINE_STAGES.includes(stageRun.stage)) continue;
    const current = latest.get(stageRun.stage);
    if (!current || Number(stageRun.attempt) > Number(current.attempt)) latest.set(stageRun.stage, stageRun);
  }
  return latest;
}

function stageSummary(status) {
  const latest = latestStageRuns(status);
  return PIPELINE_STAGES.map((stage) => `${stage}: ${latest.get(stage)?.status || 'pending'}`);
}

async function waitForRun({
  load,
  page,
  deadline,
  stopStatuses,
  intervalMs = 10_000,
}) {
  const stops = new Set(stopStatuses);
  let previous = '';
  while (Date.now() < deadline) {
    const status = await load();
    const runStatus = String(status && status.run && status.run.status || 'unknown');
    const lines = [`run: ${runStatus}`, ...stageSummary(status)];
    const signature = lines.join('|');
    if (signature !== previous) {
      previous = signature;
      await setEvidenceHud(page, 'Full QA pipeline', lines);
    }
    if (stops.has(runStatus)) return status;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('The full QA pipeline did not reach the expected state within 60 minutes.');
}

function approveDeployment({
  token,
  apiBaseUrl,
  settingsUrl,
  organizationId,
  projectId,
  repository,
  environment,
  runId,
  cwd,
  env = process.env,
}) {
  const cli = path.join(cwd, 'packages', 'cli', 'bin', 'adlc.js');
  const args = [
    cli, 'admin', 'deploy', 'approve',
    '--api', apiBaseUrl,
    '--org-id', organizationId,
    '--settings-url', settingsUrl,
    '--run-id', runId,
    '--project-id', projectId,
    '--repository', repository,
    '--environment', environment,
  ];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd,
      env: { ...env, ADLC_TOKEN: token },
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Deployment approval failed: ${boundedSafeText(stderr || stdout || error.message)}`));
        return;
      }
      resolve();
    });
  });
}

function mergeEvidence(evidenceDir, key, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const filename = path.join(evidenceDir, 'evidence.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (_) {
    current = {};
  }
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...current, [key]: value }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  return filename;
}

async function saveStableVideo(page, evidenceDir, basename, testInfo) {
  const video = page.video();
  if (!video) return null;
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const target = path.join(evidenceDir, basename);
  if (!page.isClosed()) await page.close();
  await video.saveAs(target);
  if (testInfo) await testInfo.attach(basename, { path: target, contentType: 'video/webm' });
  return target;
}

module.exports = {
  PIPELINE_STAGES,
  TERMINAL_RUN_STATUSES,
  approveDeployment,
  boundedSafeText,
  freshBrowserBearer,
  jsonRequest,
  latestStageRuns,
  mergeEvidence,
  saveStableVideo,
  setEvidenceHud,
  stageSummary,
  waitForRun,
};
