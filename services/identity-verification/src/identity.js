'use strict';

const crypto = require('node:crypto');

const CHECKS = new Set(['pan', 'ageProof', 'degree', 'apaar']);
const CLAIM_TYPES = new Set(['pan', 'apaar']);
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function normalizeChecks(input) {
  const values = Array.isArray(input) ? input : [];
  const out = [...new Set(values.map((v) => String(v || '').trim()).filter((v) => CHECKS.has(v)))];
  if (!out.length) throw Object.assign(new Error('At least one valid identity check is required.'), { status: 400, code: 'invalid_checks' });
  return out;
}

function normalizePan(value) {
  const text = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PAN_RE.test(text) ? text : '';
}

function normalizeApaar(value) {
  const text = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return text.length >= 8 && text.length <= 32 ? text : '';
}

function stableHash(value, pepper) {
  if (!pepper) throw new Error('IDENTITY_HASH_PEPPER is required for identity claims.');
  return crypto.createHmac('sha256', pepper).update(String(value), 'utf8').digest('base64url');
}

function claimId(type, hash) {
  if (!CLAIM_TYPES.has(type)) throw new Error(`Unknown identity claim type: ${type}`);
  return `${type}:${hash}`;
}

function redactPan(value) {
  const pan = normalizePan(value);
  return pan ? `*****${pan.slice(-4)}*` : '';
}

function calculateAge(dateOfBirth, now = Date.now) {
  if (!dateOfBirth) return null;
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date(now());
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = today.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function normalizeProviderResult(raw = {}, { pepper, now = Date.now } = {}) {
  const verifiedAt = nowIso(now);
  const result = { claims: [] };
  const pan = normalizePan(raw.pan && raw.pan.number);
  if (pan) {
    const hash = stableHash(pan, pepper);
    result.pan = {
      status: 'verified',
      panLast4: pan.slice(5, 9),
      panHash: hash,
      holderName: String(raw.pan.holderName || '').trim(),
      issuer: String(raw.pan.issuer || 'DigiLocker').trim(),
      documentUriHash: raw.pan.documentUri ? stableHash(raw.pan.documentUri, pepper) : '',
      verifiedAt,
    };
    result.claims.push({ claimType: 'pan', claimHash: hash });
  } else if (raw.pan) {
    result.pan = { status: 'parse_failed' };
  }

  const dob = String(raw.ageProof && raw.ageProof.dateOfBirth || '').slice(0, 10);
  if (dob) {
    result.ageProof = {
      status: 'verified',
      dateOfBirth: dob,
      ageYears: calculateAge(dob, now),
      sourceDocumentType: String(raw.ageProof.sourceDocumentType || '').trim(),
      issuer: String(raw.ageProof.issuer || 'DigiLocker').trim(),
      documentUriHash: raw.ageProof.documentUri ? stableHash(raw.ageProof.documentUri, pepper) : '',
      verifiedAt,
    };
  } else if (raw.ageProof) {
    result.ageProof = { status: 'parse_failed' };
  }

  const apaar = normalizeApaar(raw.academic && raw.academic.apaarId);
  const academicStatus = raw.academic ? (raw.academic.degreeVerified ? 'verified' : 'not_found') : undefined;
  if (raw.academic) {
    const apaarHash = apaar ? stableHash(apaar, pepper) : '';
    result.academic = {
      status: academicStatus,
      degreeVerified: Boolean(raw.academic.degreeVerified),
      institutionName: String(raw.academic.institutionName || '').trim(),
      awardName: String(raw.academic.awardName || '').trim(),
      yearOfPassing: String(raw.academic.yearOfPassing || '').trim(),
      nadDocumentUriHash: raw.academic.nadDocumentUri ? stableHash(raw.academic.nadDocumentUri, pepper) : '',
      apaarIdPresent: Boolean(apaar),
      apaarIdHash: apaarHash,
      abcLinked: Boolean(raw.academic.abcLinked),
      verifiedAt,
    };
    if (apaarHash) result.claims.push({ claimType: 'apaar', claimHash: apaarHash });
  }
  return result;
}

function publicResult(result) {
  if (!result) return null;
  const clone = JSON.parse(JSON.stringify(result));
  if (clone.pan) delete clone.pan.panHash;
  if (clone.academic) delete clone.academic.apaarIdHash;
  delete clone.claims;
  return clone;
}

module.exports = {
  CHECKS,
  normalizeChecks,
  normalizePan,
  normalizeApaar,
  stableHash,
  claimId,
  redactPan,
  calculateAge,
  normalizeProviderResult,
  publicResult,
};
