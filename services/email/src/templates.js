'use strict';

class InvalidEmailJob extends Error {
  constructor(code) {
    super(code);
    this.name = 'InvalidEmailJob';
    this.code = code;
  }
}

function boundedText(value, name, max, { required = true } = {}) {
  const text = String(value == null ? '' : value).trim();
  if ((required && !text) || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new InvalidEmailJob(`invalid_${name}`);
  }
  return text;
}

function boundedBody(value, name, max) {
  const text = String(value == null ? '' : value).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new InvalidEmailJob(`invalid_${name}`);
  }
  return text;
}

function mailbox(value) {
  const email = boundedText(value, 'recipient', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvalidEmailJob('invalid_recipient');
  return email;
}

function idempotencyKey(value) {
  const key = String(value == null ? '' : value).trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new InvalidEmailJob('invalid_idempotency_key');
  return key;
}

function parseInvitationJob(message, fallbackIdempotencyKey = '') {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new InvalidEmailJob('invalid_message');
  if (message.template !== 'invitation') throw new InvalidEmailJob('unsupported_template');
  const variables = message.variables;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    throw new InvalidEmailJob('invalid_variables');
  }

  const expiresInMinutes = variables.expiresInMinutes == null ? null : Number(variables.expiresInMinutes);
  if (expiresInMinutes !== null && (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 10080)) {
    throw new InvalidEmailJob('invalid_expiry');
  }

  return Object.freeze({
    template: 'invitation',
    idempotencyKey: idempotencyKey(message.idempotencyKey || fallbackIdempotencyKey),
    to: mailbox(message.to),
    organizationName: boundedText(variables.organizationName, 'organization_name', 200),
    invitationToken: boundedText(variables.invitationToken, 'invitation_token', 512),
    inviterName: boundedText(variables.inviterName, 'inviter_name', 200, { required: false }),
    recipientName: boundedText(variables.recipientName, 'recipient_name', 200, { required: false }),
    expiresInMinutes,
  });
}

function parseBillingAlertJob(message, fallbackIdempotencyKey = '') {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new InvalidEmailJob('invalid_message');
  if (message.template !== 'billing_alert') throw new InvalidEmailJob('unsupported_template');
  const variables = message.variables;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    throw new InvalidEmailJob('invalid_variables');
  }

  const orgId = boundedText(variables.orgId, 'org_id', 128, { required: false });
  if (orgId && !/^[A-Za-z0-9._:-]+$/.test(orgId)) throw new InvalidEmailJob('invalid_org_id');
  return Object.freeze({
    template: 'billing_alert',
    idempotencyKey: idempotencyKey(message.idempotencyKey || fallbackIdempotencyKey),
    to: mailbox(message.to),
    subject: boundedText(variables.subject, 'subject', 160),
    message: boundedBody(variables.message, 'message', 4000),
    orgId,
  });
}

function parseEmailJob(message, fallbackIdempotencyKey = '') {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new InvalidEmailJob('invalid_message');
  if (message.template === 'invitation') return parseInvitationJob(message, fallbackIdempotencyKey);
  if (message.template === 'billing_alert') return parseBillingAlertJob(message, fallbackIdempotencyKey);
  throw new InvalidEmailJob('unsupported_template');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function invitationUrl(publicAppUrl, token) {
  const base = String(publicAppUrl || '').trim().replace(/\/+$/, '');
  // Cloud Build can publish the SPA as a concrete GCS object URL. Appending a
  // slash after `index.html` changes the object path and produces a 404; a hash
  // belongs directly after the filename. Origins and directory URLs retain the
  // conventional `/#/...` form.
  const hashPath = /\.html?$/i.test(base) ? '#/invite' : '/#/invite';
  return `${base}${hashPath}?token=${encodeURIComponent(token)}`;
}

function renderInvitation(job, publicAppUrl) {
  const url = invitationUrl(publicAppUrl, job.invitationToken);
  const hello = job.recipientName ? `Hello ${job.recipientName},` : 'Hello,';
  const inviter = job.inviterName ? `${job.inviterName} invited you` : 'You have been invited';
  const expiry = job.expiresInMinutes
    ? ` This invitation expires in ${job.expiresInMinutes} minute${job.expiresInMinutes === 1 ? '' : 's'}.`
    : '';
  const subject = `Invitation to join ${job.organizationName} on AI Fleet`;
  const text = [
    hello,
    '',
    `${inviter} to join ${job.organizationName} on AI Fleet.${expiry}`,
    '',
    `Accept the invitation: ${url}`,
    '',
    'If you were not expecting this invitation, you can ignore this email.',
  ].join('\n');
  const html = [
    `<p>${escapeHtml(hello)}</p>`,
    `<p>${escapeHtml(inviter)} to join <strong>${escapeHtml(job.organizationName)}</strong> on AI Fleet.${escapeHtml(expiry)}</p>`,
    `<p><a href="${escapeHtml(url)}">Accept invitation</a></p>`,
    '<p>If you were not expecting this invitation, you can ignore this email.</p>',
  ].join('');
  return Object.freeze({ subject, text, html, url });
}

function renderBillingAlert(job) {
  const subject = `[AI Fleet Billing] ${job.subject}`;
  const referenceText = job.orgId ? `\n\nOrganization reference: ${job.orgId}` : '';
  const text = `${job.message}${referenceText}\n\nReview billing in AI Fleet.`;
  const referenceHtml = job.orgId
    ? `<p><small>Organization reference: ${escapeHtml(job.orgId)}</small></p>`
    : '';
  const html = [
    `<h2>${escapeHtml(job.subject)}</h2>`,
    `<p>${escapeHtml(job.message).replaceAll('\n', '<br>')}</p>`,
    referenceHtml,
    '<p>Review billing in AI Fleet.</p>',
  ].join('');
  return Object.freeze({ subject, text, html });
}

module.exports = {
  InvalidEmailJob,
  parseEmailJob,
  parseInvitationJob,
  parseBillingAlertJob,
  renderInvitation,
  renderBillingAlert,
  invitationUrl,
  escapeHtml,
};
