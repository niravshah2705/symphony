'use strict';

const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const { loadLiveConfig } = require('./e2e-live/support/config');

// Loading this configuration is itself the mutation safety boundary. The live
// suite cannot be collected unless every deployment-specific opt-in validates.
const live = loadLiveConfig({ requireAuth: true, requireDeploy: true });

module.exports = defineConfig({
  testDir: './e2e-live',
  outputDir: path.join(live.evidenceDir, 'artifacts'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 75 * 60 * 1_000,
  globalTimeout: 90 * 60 * 1_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['line'],
    ['html', { outputFolder: 'playwright-report/live-evidence', open: 'never' }],
  ],
  use: {
    baseURL: live.baseUrl,
    channel: 'chrome',
    headless: true,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'on',
  },
  projects: [
    {
      name: 'chrome-security',
      testMatch: /security-evidence\.spec\.js/,
    },
    {
      name: 'chrome-full-pipeline',
      testMatch: /full-pipeline\.spec\.js/,
      dependencies: ['chrome-security'],
    },
  ],
});
