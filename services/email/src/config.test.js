'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configErrors, loadConfig } = require('./config');

test('accepts a complete fixed SMTP configuration', () => {
  const config = loadConfig({
    EMAIL_SMTP_HOST: 'smtp.example.com',
    EMAIL_SMTP_PORT: '587',
    EMAIL_SMTP_USER: 'mailer',
    EMAIL_SMTP_PASSWORD: 'secret',
    EMAIL_FROM: 'AI Fleet <noreply@example.com>',
    PUBLIC_APP_URL: 'https://fleet.example.com/app',
  });
  assert.deepEqual(configErrors(config), []);
});

test('rejects partial SMTP auth, header controls, and mutable URL fragments', () => {
  const config = loadConfig({
    EMAIL_SMTP_HOST: 'smtp.example.com',
    EMAIL_SMTP_USER: 'mailer',
    EMAIL_FROM: 'noreply@example.com\r\nBcc: victim@example.com',
    PUBLIC_APP_URL: 'https://fleet.example.com/#/attacker-controlled',
  });
  assert.deepEqual(configErrors(config).sort(), ['email_from', 'public_app_url', 'smtp_auth']);
});
