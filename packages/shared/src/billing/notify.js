'use strict';

const { randomUUID } = require('node:crypto');
const log = require('../logger');
const { CONFIG } = require('../config');
const { projectEgressHeaders } = require('../egress');
const { currentWorkspaceContext } = require('../store/workspace-context');
const { paiseToInr } = require('./pricing');

/**
 * Threshold notifications across three channels:
 *   - browser  — the existing workspace SSE push (no secret; always available)
 *   - email    — queued through the shared transactional email service
 *   - slack    — an incoming webhook URL
 *
 * SMTP credentials never enter an agent container. Email producers publish an
 * allow-listed job; the shared email service alone owns SMTP and retries.
 */

function sendBrowser(payload) {
  try {
    // Route through the canonical typed publisher (agent/workspace-events) so the
    // notification event shape stays in one place. Lazy-required, fail-open.
    require('../agent/workspace-events').publishNotification({
      channel: 'billing',
      level: payload.level || 'info',
      title: payload.title || 'Billing',
      message: payload.message || '',
      orgId: payload.orgId || null,
    });
    return true;
  } catch (err) {
    log.warn(`billing notify (browser) failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function sendSlack(payload, webhookUrl = CONFIG.BILLING.slackWebhookUrl) {
  // A Slack webhook URL is itself a secret. In agent/proxy mode never honor a
  // persisted or caller-supplied URL; use the sidecar's fixed route, which
  // resolves the exact vault target and does not accept a path or origin.
  const target = CONFIG.EGRESS_PROXY_URL ? CONFIG.BILLING.slackWebhookUrl : webhookUrl;
  if (!target) return false;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CONFIG.EGRESS_PROXY_URL ? projectEgressHeaders(currentWorkspaceContext()) : {}),
      },
      body: JSON.stringify({ text: `*${payload.title}* — ${payload.message}` }),
    });
    return Boolean(res && res.ok);
  } catch (err) {
    log.warn(`billing notify (slack) failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function sendEmail(payload, recipients = [], deps = {}) {
  if (!recipients.length) return false;
  const publishRequest = deps.publishRequest || require('../messaging/publisher').publishRequest;
  const topic = deps.topic || CONFIG.GCP.emailTopic;
  const subject = String(payload.title || 'Billing alert').trim().slice(0, 160);
  const message = String(payload.message || '').trim().slice(0, 4000);
  const orgId = /^[A-Za-z0-9._:-]{1,128}$/.test(String(payload.orgId || ''))
    ? String(payload.orgId)
    : undefined;
  let published = 0;
  for (const recipient of recipients) {
    const job = {
      template: 'billing_alert',
      idempotencyKey: `billing:${randomUUID()}`,
      to: String(recipient || '').trim(),
      variables: { subject, message, ...(orgId ? { orgId } : {}) },
    };
    try {
      await publishRequest(topic, job);
      published += 1;
    } catch (err) {
      log.warn(`billing notify (email queue) failed: ${err && err.message ? err.message : err}`);
    }
  }
  return published === recipients.length;
}

/**
 * Fan a notification out to the channels enabled on the account. Browser is the
 * always-on baseline; email/slack fire only when enabled. Returns the list of
 * channels that succeeded.
 */
async function notify(account, payload) {
  const channels = (account && account.notifyChannels) || { browser: true };
  const sent = [];
  if (channels.browser !== false && sendBrowser(payload)) sent.push('browser');
  if (channels.email && (await sendEmail(payload, (account && account.notifyEmails) || []))) sent.push('email');
  if (channels.slack && (await sendSlack(payload, account && account.slackWebhookUrl))) sent.push('slack');
  return sent;
}

/**
 * Compare the account balance to its configured alert thresholds and notify on a
 * fresh DOWNWARD crossing. Dedupes via `lastAlertedThresholdPaise` so each
 * threshold fires once per crossing and escalation (low → exhausted) still
 * alerts; a recharge above the highest threshold re-arms it. Mutates the account
 * (dedupe marker). Returns the threshold alerted on (paise) or null.
 */
async function checkThresholdsAndNotify(account, deps = {}) {
  if (!account) return null;
  const storeApi = deps.store || require('../store');
  const balance = Number(account.balancePaise) || 0;
  const thresholds = (account.alertThresholdsPaise || []).map(Number).filter(Number.isFinite);
  if (!thresholds.length) return null;

  // Re-arm: balance back above the highest threshold clears the dedupe marker.
  const highest = Math.max(...thresholds);
  if (balance > highest && account.lastAlertedThresholdPaise !== null && account.lastAlertedThresholdPaise !== undefined) {
    storeApi.upsertBillingAccount(account.id, { lastAlertedThresholdPaise: null });
    account.lastAlertedThresholdPaise = null;
  }

  // The MOST SEVERE (lowest) threshold the balance has crossed.
  const crossedList = thresholds.filter((t) => balance <= t);
  if (!crossedList.length) return null;
  const crossed = Math.min(...crossedList);

  const already = account.lastAlertedThresholdPaise;
  // Alert only on a fresh crossing or an escalation to a lower threshold.
  if (already !== null && already !== undefined && crossed >= already) return null;

  const inr = paiseToInr(balance);
  const exhausted = crossed <= 0;
  const payload = {
    orgId: account.id,
    level: exhausted ? 'error' : 'warning',
    title: exhausted ? 'Billing balance exhausted' : 'Billing balance low',
    message: exhausted
      ? `Balance is ₹${inr.toFixed(2)}. Runner activity will pause until you add credits.`
      : `Balance is low: ₹${inr.toFixed(2)}.`,
  };
  await notify(account, payload);
  storeApi.upsertBillingAccount(account.id, { lastAlertedThresholdPaise: crossed });
  account.lastAlertedThresholdPaise = crossed;
  return crossed;
}

module.exports = {
  sendBrowser,
  sendSlack,
  sendEmail,
  notify,
  checkThresholdsAndNotify,
};
