'use strict';

function booleanEnv(value, fallback) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function loadConfig(env = process.env) {
  return Object.freeze({
    port: Number(env.EMAIL_SERVICE_PORT) || 4040,
    smtp: Object.freeze({
      host: String(env.EMAIL_SMTP_HOST || '').trim(),
      port: Number(env.EMAIL_SMTP_PORT) || 587,
      secure: booleanEnv(env.EMAIL_SMTP_SECURE, false),
      requireTls: booleanEnv(env.EMAIL_SMTP_REQUIRE_TLS, true),
      user: String(env.EMAIL_SMTP_USER || ''),
      password: String(env.EMAIL_SMTP_PASSWORD || ''),
    }),
    from: String(env.EMAIL_FROM || '').trim(),
    publicAppUrl: String(env.PUBLIC_APP_URL || '').trim(),
    projectId: String(env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '').trim(),
    firestoreDatabase: String(env.FIRESTORE_DATABASE || '(default)').trim(),
    idempotencyCollection: String(env.EMAIL_IDEMPOTENCY_COLLECTION || 'email_service__deliveries').trim(),
    useFirestore:
      String(env.STORE_BACKEND || '').trim().toLowerCase() === 'firestore'
      && Boolean(String(env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '').trim()),
  });
}

function configErrors(config) {
  const errors = [];
  if (!config.smtp.host) errors.push('smtp_host');
  if (!Number.isInteger(config.smtp.port) || config.smtp.port < 1 || config.smtp.port > 65535) errors.push('smtp_port');
  if (Boolean(config.smtp.user) !== Boolean(config.smtp.password)) errors.push('smtp_auth');
  if (!config.from || /[\r\n]/.test(config.from) || config.from.length > 320) errors.push('email_from');
  try {
    const url = new URL(config.publicAppUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      errors.push('public_app_url');
    }
  } catch (_) {
    errors.push('public_app_url');
  }
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(config.idempotencyCollection)) errors.push('idempotency_collection');
  return [...new Set(errors)];
}

module.exports = { loadConfig, configErrors, booleanEnv };
