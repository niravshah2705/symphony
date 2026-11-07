'use strict';

/**
 * Unified security guardrail spec — a single, pattern-agnostic description of the
 * isolation and egress/ingress rules an agent execution environment must enforce.
 *
 * Agent Substrate (renders an atenet egress policy + namespace NetworkPolicy +
 * credential-provider read policy) is the one consumer, and the spec stays
 * pattern-agnostic anyway: an operator edits guardrails once in the UI, and a
 * future substrate renders the same object instead of a new settings screen. Persisted per organization/project in
 * `settings.guardrailSpec` through the settings service.
 *
 * Enforcement is always deny-by-default: consumers must never widen a rule beyond
 * what this spec spells out.
 */

const GUARDRAIL_VERSION = 'guardrail.v1';

// Cloud instance-metadata address — always denied to block SSRF credential theft.
const METADATA_DENY_CIDR = '169.254.169.254/32';

function strArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
}

function defaultGuardrailSpec() {
  return {
    version: GUARDRAIL_VERSION,
    enforcement: 'deny-by-default',
    egress: {
      allowHosts: [],
      denyCidrs: [METADATA_DENY_CIDR],
      ports: [
        { proto: 'TCP', port: 443 },
        { proto: 'TCP', port: 80 },
        { proto: 'UDP', port: 53 },
        { proto: 'TCP', port: 53 },
      ],
      mitmTrust: { enabled: false, caRef: '' },
    },
    ingress: {
      allowedSpiffeIds: [],
      allowedServiceAccounts: [],
    },
    tools: {
      allowlist: [],
      denyAll: true,
    },
    credentials: {
      scopes: ['github', 'openrouter', 'image-registry'],
    },
    // Substrate-only: 'gvisor' | 'clh' | null (null = cluster default runtime class).
    runtimeClass: 'gvisor',
    pssProfile: 'restricted',
  };
}

function portSpec(value, fallback) {
  if (!value || typeof value !== 'object') return fallback;
  const proto = String(value.proto || fallback.proto).trim().toUpperCase() || 'TCP';
  const port = Number(value.port);
  return { proto, port: Number.isFinite(port) && port > 0 ? port : fallback.port };
}

/**
 * Coerce arbitrary stored/user input into a well-formed spec, filling defaults.
 * Never throws; invalid shapes fall back to the default value for that field.
 */
function normalizeGuardrailSpec(raw) {
  const d = defaultGuardrailSpec();
  if (!raw || typeof raw !== 'object') return d;
  const e = raw.egress && typeof raw.egress === 'object' ? raw.egress : {};
  const i = raw.ingress && typeof raw.ingress === 'object' ? raw.ingress : {};
  const t = raw.tools && typeof raw.tools === 'object' ? raw.tools : {};
  const c = raw.credentials && typeof raw.credentials === 'object' ? raw.credentials : {};
  const mitm = e.mitmTrust && typeof e.mitmTrust === 'object' ? e.mitmTrust : {};

  const ports = Array.isArray(e.ports) && e.ports.length
    ? e.ports.map((p) => portSpec(p, d.egress.ports[0]))
    : d.egress.ports;

  const denyCidrs = strArray(e.denyCidrs);
  if (!denyCidrs.includes(METADATA_DENY_CIDR)) denyCidrs.unshift(METADATA_DENY_CIDR);

  const runtimeClass = raw.runtimeClass === 'clh' || raw.runtimeClass === 'gvisor'
    ? raw.runtimeClass
    : (raw.runtimeClass === null ? null : d.runtimeClass);

  return {
    version: GUARDRAIL_VERSION,
    enforcement: 'deny-by-default',
    egress: {
      allowHosts: strArray(e.allowHosts),
      denyCidrs,
      ports,
      mitmTrust: { enabled: mitm.enabled === true, caRef: String(mitm.caRef || '').trim() },
    },
    ingress: {
      allowedSpiffeIds: strArray(i.allowedSpiffeIds),
      allowedServiceAccounts: strArray(i.allowedServiceAccounts),
    },
    tools: {
      allowlist: strArray(t.allowlist),
      denyAll: t.denyAll === false ? false : true,
    },
    credentials: {
      scopes: strArray(c.scopes).length ? strArray(c.scopes) : d.credentials.scopes,
    },
    runtimeClass,
    pssProfile: raw.pssProfile === 'baseline' ? 'baseline' : 'restricted',
  };
}

/**
 * Validate an already-normalized spec. Returns { ok, errors: string[] }.
 * Enforces the invariants the downstream renderers depend on.
 */
function validateGuardrailSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['spec must be an object'] };
  }
  if (spec.version !== GUARDRAIL_VERSION) errors.push(`version must be ${GUARDRAIL_VERSION}`);
  if (spec.enforcement !== 'deny-by-default') errors.push('enforcement must be deny-by-default');
  const cidrs = (spec.egress && spec.egress.denyCidrs) || [];
  if (!cidrs.includes(METADATA_DENY_CIDR)) errors.push(`egress.denyCidrs must include ${METADATA_DENY_CIDR}`);
  if (spec.runtimeClass !== null && !['gvisor', 'clh'].includes(spec.runtimeClass)) {
    errors.push('runtimeClass must be gvisor, clh, or null');
  }
  for (const p of (spec.egress && spec.egress.ports) || []) {
    if (!Number.isFinite(p.port) || p.port <= 0 || p.port > 65535) errors.push(`invalid egress port ${p.port}`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  GUARDRAIL_VERSION,
  METADATA_DENY_CIDR,
  defaultGuardrailSpec,
  normalizeGuardrailSpec,
  validateGuardrailSpec,
};
