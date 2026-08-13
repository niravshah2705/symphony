'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TERMINAL_PIPELINE_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const SECRET_TEXT = /(?:authorization\s*[:=]\s*|bearer\s+)?(?:eyJ[A-Za-z0-9._-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/gi;
const EMAIL_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_TEXT = /https?:\/\/[^\s]+/gi;

function boundedEvidenceText(value, max = 500) {
  return String(value || '')
    .replace(SECRET_TEXT, '[redacted credential]')
    .replace(EMAIL_TEXT, '[redacted email]')
    .replace(URL_TEXT, '[redacted URL]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function stringField(source, names) {
  for (const name of names) {
    const value = source && source[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function tenantFixture(value, label, { requireKnownResources = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fixture = Object.freeze({
    organizationId: stringField(source, ['organizationId', 'orgId']),
    projectId: stringField(source, ['projectId', 'nativeProjectId']),
    canary: stringField(source, ['canary']),
    settingsProjectId: stringField(source, ['settingsProjectId'])
      || stringField(source, ['projectId', 'nativeProjectId']),
    conversationId: stringField(source, ['conversationId']),
    terminalRunId: stringField(source, ['terminalRunId']),
  });
  for (const required of ['organizationId', 'projectId', 'canary']) {
    if (!fixture[required]) {
      throw new Error(`E2E_QA_FIXTURES_JSON must define fixtures.${label}.${required}.`);
    }
  }
  if (requireKnownResources) {
    for (const required of ['conversationId', 'terminalRunId']) {
      if (!fixture[required]) {
        throw new Error(`E2E_QA_FIXTURES_JSON must define fixtures.${label}.${required}.`);
      }
    }
  }
  return fixture;
}

function requireSecurityFixtures(fixtures) {
  if (!fixtures || fixtures.nonProduction !== true || fixtures.disposable !== true) {
    throw new Error('Security E2E fixtures must set nonProduction:true and disposable:true.');
  }
  const tenantA = tenantFixture(fixtures && fixtures.tenantA, 'tenantA');
  const tenantB = tenantFixture(fixtures && fixtures.tenantB, 'tenantB', {
    requireKnownResources: true,
  });
  if (tenantA.organizationId === tenantB.organizationId) {
    throw new Error('Tenant A and Tenant B must use different organization ids.');
  }
  if (tenantA.projectId === tenantB.projectId) {
    throw new Error('Tenant A and Tenant B must use different native project ids.');
  }
  if (tenantA.canary === tenantB.canary) {
    throw new Error('Tenant A and Tenant B must use distinct canary values.');
  }
  return Object.freeze({ tenantA, tenantB });
}

function apiErrorCode(data) {
  const nested = data && data.error && typeof data.error === 'object' ? data.error : null;
  return String((data && data.code) || (nested && nested.code) || '');
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

async function apiProbe(baseUrl, pathname, {
  method = 'GET',
  token = '',
  organizationId = '',
  projectId = '',
  body,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = new URL(pathname, `${String(baseUrl).replace(/\/+$/, '')}/`);
  const origin = new URL(baseUrl).origin;
  if (target.origin !== origin || !target.pathname.startsWith('/api/')) {
    throw new Error('Security probes must remain on the selected gateway /api origin.');
  }
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (organizationId) headers['x-ai-fleet-organization-id'] = organizationId;
  if (projectId) headers['x-ai-fleet-project-id'] = projectId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchImpl(
    target.href,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    },
  );
  const data = await readJson(response);
  return Object.freeze({ status: response.status, code: apiErrorCode(data), data });
}

async function browserApiBase(page) {
  const value = await page.evaluate(async () => {
    const { getApiBase } = await import('/js/api.js');
    return getApiBase() || window.location.origin;
  });
  return String(value).replace(/\/+$/, '');
}

async function freshAuthenticatedBrowserSession(page) {
  const requestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/auth/me'
      && /^Bearer\s+\S+$/i.test(request.headers().authorization || '');
  }, { timeout: 25_000 });
  await page.evaluate(async () => {
    const auth = await import('/js/auth.js');
    const apiModule = await import('/js/api.js');
    await auth.ensureFreshToken();
    await apiModule.api.getCurrentUser();
  });
  const request = await requestPromise;
  const authorization = request.headers().authorization || '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token || token === authorization) {
    throw new Error('The authenticated browser did not provide a Firebase bearer token.');
  }
  return Object.freeze({ token, apiBaseUrl: new URL(request.url()).origin });
}

async function setSecurityEvidenceHud(page, title, lines = []) {
  if (page.isClosed()) return;
  const heading = boundedEvidenceText(title, 100);
  const values = lines.map((line) => boundedEvidenceText(line, 150)).slice(0, 9);
  await page.evaluate(({ safeHeading, safeValues }) => {
    let hud = document.querySelector('[data-e2e-security-evidence]');
    if (!hud) {
      hud = document.createElement('aside');
      hud.dataset.e2eSecurityEvidence = 'true';
      hud.setAttribute('aria-live', 'polite');
      hud.setAttribute('aria-label', 'Sanitized end-to-end security evidence');
      Object.assign(hud.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: '2147483647',
        width: 'min(430px, calc(100vw - 36px))',
        padding: '15px 17px',
        border: '1px solid rgba(125,211,252,.45)',
        borderRadius: '12px',
        background: 'rgba(8,15,28,.95)',
        color: '#e2e8f0',
        boxShadow: '0 16px 44px rgba(0,0,0,.42)',
        font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
      });
      document.body.appendChild(hud);
    }
    hud.textContent = [`SECURITY EVIDENCE — ${safeHeading}`, ...safeValues].join('\n');
  }, { safeHeading: heading, safeValues: values });
}

async function settleEvidenceFrame(page) {
  if (page.isClosed()) return;
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  // Keep the final, sanitized status card present long enough to be encoded as a
  // useful final video frame. This delay is evidence capture, not app readiness.
  await page.waitForTimeout(500);
}

function mergeScenarioEvidence(evidenceDir, scenario, evidence) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const filename = path.join(evidenceDir, 'evidence.json');
  let current = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
  } catch (_) {
    current = {};
  }
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ ...current, [scenario]: evidence }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temporary, filename);
  return filename;
}

async function saveSecurityVideo(page, evidenceDir, basename, testInfo) {
  const video = page.video();
  if (!video) throw new Error('Live Playwright configuration must enable video recording.');
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const target = path.join(evidenceDir, basename);
  if (!page.isClosed()) await page.close();
  await video.saveAs(target);
  if (testInfo) {
    await testInfo.attach(basename, { path: target, contentType: 'video/webm' });
  }
  return target;
}

function isTerminalPipelineStatus(value) {
  return TERMINAL_PIPELINE_STATUSES.has(String(value || '').toLowerCase());
}

module.exports = {
  TERMINAL_PIPELINE_STATUSES,
  apiProbe,
  boundedEvidenceText,
  browserApiBase,
  freshAuthenticatedBrowserSession,
  isTerminalPipelineStatus,
  mergeScenarioEvidence,
  requireSecurityFixtures,
  saveSecurityVideo,
  setSecurityEvidenceHud,
  settleEvidenceFrame,
};
