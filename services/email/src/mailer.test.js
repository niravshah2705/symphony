'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer } = require('./mailer');
const { loadConfig } = require('./config');
const { parseBillingAlertJob, parseInvitationJob } = require('./templates');

function config(overrides = {}) {
  return loadConfig({
    EMAIL_SMTP_HOST: 'smtp.example.com',
    EMAIL_SMTP_PORT: '587',
    EMAIL_SMTP_USER: 'mailer',
    EMAIL_SMTP_PASSWORD: 'secret',
    EMAIL_FROM: 'AI Fleet <noreply@example.com>',
    PUBLIC_APP_URL: 'https://fleet.example.com',
    ...overrides,
  });
}

function job() {
  return parseInvitationJob({
    template: 'invitation',
    idempotencyKey: 'invite:one',
    to: 'person@example.com',
    variables: { organizationName: 'Acme', invitationToken: 'opaque-token' },
  });
}

test('uses the injected SMTP transport with fixed template fields only', async () => {
  const sent = [];
  const transport = {
    verify: async () => true,
    sendMail: async (mail) => { sent.push(mail); return { messageId: 'm-1' }; },
  };
  const mailer = createMailer(config(), { transport });
  assert.equal(await mailer.ready(), true);
  await mailer.sendInvitation(job());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'person@example.com');
  assert.equal(sent[0].from, undefined); // fixed transporter default; callers cannot override it
  assert.equal(sent[0].replyTo, undefined);
  assert.equal(sent[0].subject, 'Invitation to join Acme on AI Fleet');
  assert.equal(sent[0].disableFileAccess, true);
  assert.equal(sent[0].disableUrlAccess, true);
  assert.match(sent[0].text, /https:\/\/fleet\.example\.com\/#\/invite\?token=opaque-token/);
});

test('readiness is false and sending fails closed when required config is absent', async () => {
  const mailer = createMailer(config({ EMAIL_FROM: '', PUBLIC_APP_URL: '' }), {
    transport: { sendMail: async () => { throw new Error('must not send'); } },
  });
  assert.equal(await mailer.ready(), false);
  await assert.rejects(() => mailer.sendInvitation(job()), /not configured/);
});

test('billing alerts use the same fixed SMTP envelope and server-rendered body', async () => {
  const sent = [];
  const mailer = createMailer(config(), {
    transport: { sendMail: async (mail) => { sent.push(mail); } },
  });
  const alert = parseBillingAlertJob({
    template: 'billing_alert',
    idempotencyKey: 'billing:one',
    to: 'owner@example.com',
    variables: { subject: 'Balance low', message: 'Please add credits.', orgId: 'org-1' },
  });
  await mailer.sendBillingAlert(alert);
  assert.equal(sent[0].from, undefined);
  assert.equal(sent[0].replyTo, undefined);
  assert.equal(sent[0].subject, '[AI Fleet Billing] Balance low');
  assert.match(sent[0].html, /Please add credits\./);
  assert.equal(sent[0].disableFileAccess, true);
  assert.equal(sent[0].disableUrlAccess, true);
});
