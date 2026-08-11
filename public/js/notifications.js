// Global user notifications. Renders `notification` SSE events (e.g. billing
// threshold alerts) as a native browser Notification when permitted, always
// falling back to an in-app toast. Opens ONE global workspace stream after
// sign-in so alerts arrive on any route, not just the Agent workspace.

import { api } from './api.js';
import { toast } from './dom.js';

let started = false;
const recent = new Map(); // dedupe key -> last-shown epoch ms
const DEDUPE_MS = 30_000;

function permissionGranted() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

async function ensurePermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch (_) {
    return false;
  }
}

function toastType(level) {
  if (level === 'error') return 'error';
  if (level === 'warning') return 'warn';
  return 'ok';
}

/** Render one notification event: native Notification when allowed, always a toast. */
export function showNotification(event) {
  if (!event || event.type !== 'notification') return;
  const title = event.title || 'AI Fleet';
  const body = event.message || '';
  const key = `${event.channel || ''}:${title}:${body}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEDUPE_MS) return; // suppress rapid repeats
  recent.set(key, now);
  if (permissionGranted()) {
    try {
      // eslint-disable-next-line no-new
      new Notification(title, { body, tag: key });
    } catch (_) {
      /* fall through to the toast */
    }
  }
  toast(body ? `${title} — ${body}` : title, toastType(event.level));
}

/**
 * Open ONE global workspace SSE stream and surface `notification` events. Safe to
 * call once after sign-in; a no-op if already started. Best-effort — a failure
 * leaves it un-started so a later call can retry.
 */
export async function initNotifications() {
  if (started) return;
  started = true;
  await ensurePermission();
  try {
    await api.openWorkspaceStream((event) => {
      if (event && event.type === 'notification') showNotification(event);
    });
  } catch (_) {
    started = false;
  }
}
