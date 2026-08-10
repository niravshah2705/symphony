// Client-side secret/token scanner for the Agent omnibox.
//
// Best-effort guard that keeps a user from accidentally sending an API key,
// token, or private key to the server in plaintext. It is a UX convenience,
// NOT a trust boundary — the server-side redactor is the real backstop
// (see packages/shared/src/agent/tools/exec.js `redactSecrets`). This ruleset
// intentionally MIRRORS that server ruleset (exec.js:88-93) and extends it with
// a few well-known, low-false-positive prefixes; keep the two in sync, the same
// way public/js/omnibox-router.mjs mirrors the server workspace-router.
//
// Dependency-free, no DOM access — importable under `node --test`.

/** Placeholder that replaces every detected secret. Matches the server token. */
export const REDACTION_PLACEHOLDER = '«redacted»';

/**
 * Ordered secret patterns. Broad `key = value` / authorization patterns run
 * first (they keep the key name and blank only the value), then specific token
 * shapes. `label` is the human-readable TYPE surfaced to the user — the secret
 * VALUE is never exposed. `replace` defaults to the bare placeholder.
 * @type {ReadonlyArray<{ id: string, label: string, re: RegExp, replace?: string }>}
 */
export const SECRET_PATTERNS = Object.freeze([
  {
    id: 'authorization',
    label: 'Authorization header/token',
    re: /((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: `$1${REDACTION_PLACEHOLDER}`,
  },
  {
    id: 'credential-assignment',
    label: 'Credential assignment',
    re: /((?:private-token|x-api-key|api[_-]?key|access[_-]?token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s'";,&]+/gi,
    replace: `$1${REDACTION_PLACEHOLDER}`,
  },
  { id: 'private-key', label: 'Private key', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)?/g },
  { id: 'github-token', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { id: 'github-pat-fine', label: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'gitlab-token', label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'openai-key', label: 'OpenAI API key', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { id: 'stripe-key', label: 'Stripe secret key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'slack-webhook', label: 'Slack webhook URL', re: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_+-]{10,}/g },
  { id: 'aws-access-key', label: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'jwt', label: 'JSON Web Token (JWT)', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
]);

/**
 * Scan text for secrets. Returns a NEW redacted string (never mutates input)
 * and the distinct list of secret TYPES found. The returned `types` and
 * `redacted` never contain any matched secret value.
 * @param {unknown} text
 * @returns {{ found: boolean, types: string[], redacted: string }}
 */
export function scanSecrets(text) {
  let redacted = String(text == null ? '' : text);
  const types = [];
  for (const { label, re, replace } of SECRET_PATTERNS) {
    // `String.prototype.replace` with a /g regex scans from the start and resets
    // lastIndex, so the shared pattern objects are safe to reuse across calls.
    const before = redacted;
    redacted = redacted.replace(re, replace || REDACTION_PLACEHOLDER);
    if (redacted !== before && !types.includes(label)) types.push(label);
  }
  return { found: types.length > 0, types, redacted };
}
