'use strict';

const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL || '';
const gatewayPort = Number(process.env.PLAYWRIGHT_PORT) || 1456;
const plannerPort = gatewayPort + 1;
const coderPort = gatewayPort + 2;
const baseURL = externalBaseURL || `http://127.0.0.1:${gatewayPort}`;

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { channel: 'chrome' },
    },
  ],
  webServer: externalBaseURL ? undefined : {
    // The backend is Python now; the e2e harness boots the whole Python fleet
    // (gateway + planner + coder). Requires the ai_fleet package to be importable
    // (e.g. `pip install -e .` or an active venv). The env below is honored by
    // ai_fleet/config.py exactly as the Node services honored it.
    command: 'python -m ai_fleet.start_all',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      PLANNER_PORT: String(plannerPort),
      CODER_SERVICE_PORT: String(coderPort),
      PLANNER_URL: `http://127.0.0.1:${plannerPort}`,
      CODER_URL: `http://127.0.0.1:${coderPort}`,
      AI_FLEET_DATA_DIR: path.join(__dirname, 'test-results', 'runtime-data'),
    },
  },
});
