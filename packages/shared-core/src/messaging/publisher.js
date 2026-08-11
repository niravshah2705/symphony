'use strict';

const { CONFIG } = require('../config');

/**
 * Request publisher for the planner/coder on-demand path.
 *
 * Two modes (CONFIG.MESSAGING_MODE):
 *   - 'pubsub' : publish to a Cloud Pub/Sub topic (push-delivered to the service).
 *   - 'direct' : POST the SAME Pub/Sub-push-shaped envelope straight to the
 *                target service's /pubsub/* handler in-process — so local
 *                `npm start` needs no emulator and the handler code is identical.
 */

// Topic name -> the in-process HTTP endpoint that handles it (direct mode).
function directRoute(topic) {
  if (topic === CONFIG.GCP.plannerTopic) return `${CONFIG.SERVICES.plannerUrl}/pubsub/planner`;
  if (topic === CONFIG.GCP.coderTopic) return `${CONFIG.SERVICES.coderUrl}/pubsub/coder`;
  if (topic === CONFIG.GCP.emailTopic) return `${CONFIG.SERVICES.emailUrl}/pubsub/email`;
  return null;
}

let pubsub = null;
function getPubSub() {
  if (pubsub) return pubsub;
  const { PubSub } = require('@google-cloud/pubsub');
  pubsub = new PubSub({ projectId: CONFIG.GCP.projectId || undefined });
  return pubsub;
}

/** Wrap a message as a Pub/Sub push envelope: { message: { data: base64 } }. */
function toPushEnvelope(message) {
  return { message: { data: Buffer.from(JSON.stringify(message)).toString('base64') } };
}

/** Decode a Pub/Sub push body (or a direct-mode envelope) back to the message. */
function decodePushMessage(body) {
  const data = body && body.message && body.message.data;
  if (!data) return null;
  try {
    return JSON.parse(Buffer.from(String(data), 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Publish a request to a topic. Returns { id }. Throws on transport failure so
 * the caller can surface a clear error to the browser.
 */
async function publishRequest(topic, message) {
  if (CONFIG.MESSAGING_MODE === 'pubsub') {
    const id = await getPubSub().topic(topic).publishMessage({ json: message });
    return { id };
  }
  const target = directRoute(topic);
  if (!target) throw new Error(`No direct route configured for topic "${topic}"`);
  const resp = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toPushEnvelope(message)),
  });
  if (!resp.ok) throw new Error(`Direct publish to ${target} failed (${resp.status})`);
  return { id: `direct-${new Date().toISOString()}` };
}

module.exports = { publishRequest, decodePushMessage, toPushEnvelope };
