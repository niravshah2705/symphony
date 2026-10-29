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
    const events = require('../agent/workspace-events');
    if (events && typeof events.publishNotification === 'function') {
      events.publishNotification({
        channel: 'billing',
        level: payload.level || 'info',
        title: payload.title || 'Billing',
        message: payload.message || '',
        orgId: payload.orgId || null,
      });
      return true;
    }
  } catch (err) {
    log.warn(`billing notify (browser) failed: ${err && err.message ? err.message : err}`);
  }
  return false;
}

async function sendSlack(payload, webhookUrl = CONFIG.BILLING.slackWebhookUrl) {
  const target = CONFIG.EGRESS_PROXY_URL ? CONFIG.BILLING.slackWebhookUrl : webhookUrl;
  if (!target) return false;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CONFIG.EGRESS_PROXY_URL ? projectEgressHeaders(currentWorkspaceContext()) : {}),
      },
      body: JSON.stringify({
        text: `*${payload.title}*\n${payload.message}`,
        attachments: payload.details ? [{ text: JSON.stringify(payload.details, null, 2) }] : undefined,
      }),
    });
    return res.ok;
  } catch (err) {
    log.warn(`billing notify (slack) failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function sendEmail(payload, to = CONFIG.BILLING.notifyEmail) {
  if (!to) return false;
  try {
    const { publishEmailJob } = require('../messaging/email-publisher');
    if (typeof publishEmailJob === 'function') {
      await publishEmailJob({
        jobId: randomUUID(),
        to,
        subject: `[AI Fleet] ${payload.title}`,
        template: 'billing-alert',
        vars: {
          title: payload.title,
          message: payload.message,
          balanceInr: payload.details && payload.details.balanceInr,
          thresholdInr: payload.details && payload.details.thresholdInr,
        },
      });
      return true;
    }
  } catch (err) {
    log.warn(`billing notify (email) failed: ${err && err.message ? err.message : err}`);
  }
  return false;
}

async function notify(payload, channels = {}) {
  const tasks = [];
  if (channels.browser !== false) tasks.push(Promise.resolve(sendBrowser(payload)));
  if (channels.slack) tasks.push(sendSlack(payload));
  if (channels.email) tasks.push(sendEmail(payload));
  const results = await Promise.allSettled(tasks);
  return results.some((r) => r.status === 'fulfilled' && r.value === true);
}

/**
 * Compare current balance against configured thresholds and fire a notification
 * for any threshold crossed since last notified.
 */
async function checkThresholdsAndNotify(orgId, account, state = {}) {
  const balancePaise = Number(account.balancePaise) || 0;
  const thresholdsInr = Array.isArray(account.alertThresholdsInr)
    ? account.alertThresholdsInr
    : CONFIG.BILLING.defaultThresholdsInr;

  const thresholdsPaise = thresholdsInr.map((inr) => Math.round(Number(inr) * 100)).sort((a, b) => a - b);
  const lastAlertedPaise = state.lastAlertedPaise ?? Infinity;

  const crossed = thresholdsPaise.filter((t) => balancePaise <= t && t < lastAlertedPaise);
  if (!crossed.length) return null;

  const lowestCrossed = crossed[0];
  const payload = {
    orgId,
    level: balancePaise <= 0 ? 'critical' : 'warn',
    title: balancePaise <= 0 ? 'Billing balance exhausted' : 'Low balance alert',
    message: `Account balance is ₹${paiseToInr(balancePaise)} (crossed ₹${paiseToInr(lowestCrossed)} threshold).`,
    details: {
      orgId,
      balanceInr: paiseToInr(balancePaise),
      thresholdInr: paiseToInr(lowestCrossed),
    },
  };

  await notify(payload, account.notifyChannels || {});
  return lowestCrossed;
}

module.exports = {
  notify,
  checkThresholdsAndNotify,
  sendBrowser,
  sendSlack,
  sendEmail,
};
