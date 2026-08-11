'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InvalidEmailJob,
  parseEmailJob,
  parseInvitationJob,
  parseBillingAlertJob,
  renderBillingAlert,
  renderInvitation,
  invitationUrl,
} = require('./templates');

function message(overrides = {}) {
  return {
    template: 'invitation',
    idempotencyKey: 'invite:org-1:user-1',
    to: 'New.User@Example.com',
    variables: {
      organizationName: 'Acme & Sons',
      invitationToken: 'token/with?reserved=chars',
      inviterName: 'Alice <Admin>',
      recipientName: 'Bob',
      expiresInMinutes: 60,
    },
    ...overrides,
  };
}

test('parses only the invitation contract and normalizes the recipient', () => {
  const job = parseInvitationJob(message());
  assert.equal(job.template, 'invitation');
  assert.equal(job.to, 'new.user@example.com');
  assert.equal(job.organizationName, 'Acme & Sons');
  assert.equal(job.expiresInMinutes, 60);
  assert.ok(Object.isFrozen(job));
});

test('uses the Pub/Sub message id when a caller idempotency key is absent', () => {
  const input = message();
  delete input.idempotencyKey;
  assert.equal(parseInvitationJob(input, 'pubsub-message-42').idempotencyKey, 'pubsub-message-42');
});

test('rejects arbitrary templates, invalid mailboxes, controls, and unsafe keys', () => {
  const cases = [
    message({ template: 'raw' }),
    message({ to: 'not-an-email' }),
    message({ idempotencyKey: '../unsafe' }),
    message({ variables: { ...message().variables, organizationName: 'Acme\r\nBcc: victim@example.com' } }),
    message({ variables: { ...message().variables, expiresInMinutes: 0 } }),
  ];
  for (const input of cases) assert.throws(() => parseInvitationJob(input), InvalidEmailJob);
});

test('renders a fixed invitation template and escapes values and token URL', () => {
  const job = parseInvitationJob(message());
  const rendered = renderInvitation(job, 'https://fleet.example.com/');
  assert.equal(rendered.subject, 'Invitation to join Acme & Sons on AI Fleet');
  assert.match(rendered.text, /Accept the invitation: https:\/\/fleet\.example\.com\/#\/invite\?token=token%2Fwith%3Freserved%3Dchars/);
  assert.match(rendered.html, /Alice &lt;Admin&gt;/);
  assert.match(rendered.html, /Acme &amp; Sons/);
  assert.doesNotMatch(rendered.html, /Alice <Admin>/);
});

test('builds invitation links for both origins and concrete hosted SPA objects', () => {
  assert.equal(
    invitationUrl('https://fleet.example.com/', 'one/two'),
    'https://fleet.example.com/#/invite?token=one%2Ftwo',
  );
  assert.equal(
    invitationUrl('https://storage.googleapis.com/fleet-ui/index.html', 'one/two'),
    'https://storage.googleapis.com/fleet-ui/index.html#/invite?token=one%2Ftwo',
  );
});

test('parses and server-renders a bounded billing alert', () => {
  const job = parseEmailJob({
    template: 'billing_alert',
    idempotencyKey: 'billing:org-1:threshold-500',
    to: 'Owner@Example.com',
    variables: {
      subject: 'Balance < low',
      message: 'Balance is low.\nAdd credits.',
      orgId: 'org-1',
    },
  });
  assert.equal(job.to, 'owner@example.com');
  assert.equal(job.template, 'billing_alert');
  const rendered = renderBillingAlert(job);
  assert.equal(rendered.subject, '[AI Fleet Billing] Balance < low');
  assert.match(rendered.text, /Organization reference: org-1/);
  assert.match(rendered.html, /Balance &lt; low/);
  assert.match(rendered.html, /Balance is low\.<br>Add credits\./);
  assert.doesNotMatch(rendered.html, /< low/);
});

test('rejects unsafe or unbounded billing alert fields', () => {
  const base = {
    template: 'billing_alert',
    idempotencyKey: 'billing:one',
    to: 'owner@example.com',
    variables: { subject: 'Low balance', message: 'Add credits', orgId: 'org-1' },
  };
  assert.throws(() => parseBillingAlertJob({ ...base, variables: { ...base.variables, subject: 'x'.repeat(161) } }), InvalidEmailJob);
  assert.throws(() => parseBillingAlertJob({ ...base, variables: { ...base.variables, message: 'x'.repeat(4001) } }), InvalidEmailJob);
  assert.throws(() => parseBillingAlertJob({ ...base, variables: { ...base.variables, subject: 'bad\r\nBcc: victim@example.com' } }), InvalidEmailJob);
  assert.throws(() => parseBillingAlertJob({ ...base, variables: { ...base.variables, orgId: '../org' } }), InvalidEmailJob);
});
