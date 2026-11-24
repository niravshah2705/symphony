#!/usr/bin/env node
// Browser-level check for the self-hosted Flexprice dashboard login
// (http://flexprice.local). curl-ing /v1/auth/login is NOT enough: the SPA only
// calls it when built with VITE_APP_ENV=self-hosted, otherwise LoginForm takes
// the Supabase branch and shows "Authentication is not configured for this
// deployment." This script drives the real form and asserts the backend call
// happens and the session lands past /login.
//
// Usage:  node fleet-local/scripts/fixes/t30-ui-login-check.mjs <email> <password>
//         UI_ORIGIN / API_ORIGIN can override the hosts.
// Needs:  npx playwright install chromium   (once per machine)
import { chromium } from 'playwright';
import fs from 'node:fs';

const UI = process.env.UI_ORIGIN || 'http://flexprice.local';
const email = process.argv[2];
const password = process.argv[3];
const fail = (msg, extra = '') => {
  console.log(`FAIL: ${msg}${extra ? `\n  ${extra}` : ''}`);
  process.exitCode = 1;
};
if (!email || !password) fail('usage: t30-ui-login-check.mjs <email> <password>');

const shot = process.env.UI_CHECK_SHOT || '/tmp/t30-ui-login.png';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
const apiCalls = [];
const apiFailures = [];
page.on('response', async (r) => {
  if (!r.url().includes('/v1/')) return;
  apiCalls.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  if (r.status() >= 400) {
    apiFailures.push(`${r.status()} ${r.request().method()} ${r.url()} :: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  }
});

try {
  // build-info.json is emitted by the image build — proves the served bundle is
  // the one we just built, before blaming the credentials for anything.
  const info = await (await fetch(`${UI}/build-info.json`)).json().catch(() => null);
  console.log(`build-info: ${JSON.stringify(info)}`);
  if (!info) fail('no build-info.json from ' + UI + ' — stale image (re-run t30 with FORCE=1)');
  else if (info.appEnv !== 'self-hosted') fail(`bundle built with appEnv=${info.appEnv}, expected self-hosted — login would take the Supabase branch`);

  await page.goto(`${UI}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/v1/auth/login'), { timeout: 20000 }).catch(() => null),
    // Not a form submit: LoginForm's action is <Button onClick={handleLogin}>,
    // so pressing Enter in the password field does nothing.
    page.locator('form button').last().click(),
  ]);
  // Long enough for the landing page's own queries (rbac/roles, features) to
  // arrive, so the 4xx sweep below covers them.
  await page.waitForTimeout(6000);

  const loginReq = apiCalls.find((l) => l.includes('/v1/auth/login'));
  if (!loginReq) fail('the SPA never called /v1/auth/login — LoginForm took the Supabase branch', apiCalls.join('\n  '));
  else if (!loginReq.startsWith('200')) fail('/v1/auth/login was not 200', loginReq);
  else console.log('login request: ' + loginReq);

  const toasts = (await page.locator('[data-testid="toast"]').allTextContents()).map((t) => t.trim()).filter(Boolean);
  if (toasts.length) fail('error/success toast visible after login', toasts.join(' | '));

  if (page.url().endsWith('/login')) fail('still on /login after submitting — no session established');
  else console.log(`session established, landed on: ${page.url()}`);

  const me = await page.evaluate(async () => {
    const raw = localStorage.getItem('token');
    return raw ? JSON.parse(raw) : null;
  });
  if (!me?.token) fail('localStorage.token missing — AuthService will not authenticate API calls');
  else console.log('token stored for user_id ' + me.user_id);

  // The onboarding gate must read the seeded metadata, not just accept the token.
  const gated = await page.evaluate(() => localStorage.getItem('flexprice_onboarding_completed_v1'));
  console.log(`localStorage onboarding flag: ${gated === null ? '(unset — server metadata decides)' : gated}`);

  // Any 4xx on the dashboard's first load is a seed/config problem even when
  // the login itself succeeded -- e.g. users.type='owner' making
  // GET /v1/rbac/roles?user_type=owner a validation_error.
  if (apiFailures.length) fail(`${apiFailures.length} API call(s) failed after login`, apiFailures.join('\n  '));
  else console.log(`clean: ${apiCalls.length} /v1 calls, no 4xx/5xx`);

  await page.screenshot({ path: shot, fullPage: true });
  console.log(`screenshot: ${shot}`);
} catch (e) {
  fail('exception', e.message);
  await page.screenshot({ path: shot }).catch(() => {});
} finally {
  if (errors.length) console.log('page errors:\n  ' + errors.slice(0, 6).join('\n  '));
  await browser.close();
}
process.exit(process.exitCode || 0);
