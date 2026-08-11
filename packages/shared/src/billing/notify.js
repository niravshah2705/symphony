'use strict';

const log = require('../logger');
const { paiseToInr } = require('./pricing');

/**
 * Threshold notifications across three channels:
 *   - browser  — the existing workspace SSE push (no secret; always available)
 *   - email    — SMTP via nodemailer (optional dep + BILLING_SMTP_URL)
 *   - slack    — an incoming webhook URL
 *
 * Email/Slack connection creds are read from TRUSTED server-side env and are
 * OPTIONAL: a missing cred simply skips that channel (fail-open). NOTE: agent
 * containers (planner/coder) must not hold raw third-party secrets, so in
 * production the notifier should run on a non-proxied service (or resolve creds
 * from the settings vault). Browser notifications work from anywhere.
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

async function sendSlack(payload, webhookUrl = process.env.BILLING_SLACK_WEBHOOK_URL) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${payload.title}* — ${payload.message}` }),
    });
    return Boolean(res && res.ok);
  } catch (err) {
    log.warn(`billing notify (slack) failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function sendEmail(payload, recipients = [], smtpUrl = process.env.BILLING_SMTP_URL) {
  if (!smtpUrl || !recipients.length) return false;
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    log.warn('billing notify (email) skipped: nodemailer not installed');
    return false;
  }
  try {
    const from = process.env.BILLING_EMAIL_FROM || 'ai-fleet@localhost';
    const transport = nodemailer.createTransport(smtpUrl);
    await transport.sendMail({ from, to: recipients.join(','), subject: payload.title, text: payload.message });
    return true;
  } catch (err) {
    log.warn(`billing notify (email) failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

/**
 * Fan a notification out to the channels enabled on the account. Browser is the
 * always-on baseline; email/slack fire only when both enabled AND their creds
 * are present. Returns the list of channels that succeeded.
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
