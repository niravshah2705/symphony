'use strict';

/**
 * Guest template bundles: the presetup the demo deploys.
 *
 * The agent does not author a site at runtime for a guest — it selects one of
 * these first-party bundles and one of the bundle's own allowlisted variants,
 * and the deployer releases the resulting files. That keeps two invariants
 * true at once: nothing a visitor could type reaches the released HTML (the
 * only guest input is an enumerated answer id, and a variant value outside the
 * bundle's `knobs` is rejected here), and the "deploy as a webapp" step ends
 * with a real page rather than a promise.
 *
 * `variant.schema.md` documents the bundle format this loader implements. A
 * `{{TOKEN}}` left over after substitution is an error, not a shipped brace: it
 * means the copy references a knob or token the bundle no longer defines.
 */

const fs = require('node:fs');
const path = require('node:path');

const { TEMPLATES } = require('../catalog.js');

const ROOT = __dirname;
const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;
const MAX_SUBSTITUTION_PASSES = 3;

class GuestTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuestTemplateError';
    this.code = code;
    this.status = 400;
  }
}

/** Inside the templates tree only — a bundle cannot point at an arbitrary file. */
function resolveBundlePath(src, name) {
  const resolved = path.resolve(ROOT, name, src);
  const root = path.resolve(ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new GuestTemplateError('guest_template_path_invalid', `Bundle "${name}" references a file outside the template tree.`);
  }
  return resolved;
}

function readJson(file, name) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    throw new GuestTemplateError('guest_template_missing', `Template "${name}" is missing ${path.basename(file)}.`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new GuestTemplateError('guest_template_invalid', `Template "${name}" has a malformed ${path.basename(file)}.`);
  }
}

function loadGuestTemplate(name) {
  if (typeof name !== 'string' || !TEMPLATES.includes(name)) {
    throw new GuestTemplateError('guest_template_unknown', 'That template is not available.');
  }
  const deploy = readJson(path.join(ROOT, name, 'deploy.json'), name);
  const variantRef = typeof deploy.variant === 'string' && deploy.variant.trim()
    ? resolveBundlePath(deploy.variant, name)
    : path.join(ROOT, name, 'variant.json');
  const variantSpec = readJson(variantRef, name);
  if (!deploy.tokens || typeof deploy.tokens !== 'object' || !Array.isArray(deploy.files)) {
    throw new GuestTemplateError('guest_template_invalid', `Template "${name}" has no tokens or files table.`);
  }
  return { name, deploy, variantSpec };
}

/**
 * Merge the requested selections over the bundle's defaults, and refuse
 * anything the bundle does not offer. The allowlist is the whole defence here,
 * so it runs before any file is read or any token is built.
 */
function resolveVariant(variantSpec, requested) {
  const knobs = variantSpec.knobs || {};
  const merged = { ...(variantSpec.defaults || {}) };
  if (requested === null || requested === undefined) return merged;
  if (typeof requested !== 'object' || Array.isArray(requested)) {
    throw new GuestTemplateError('guest_variant_invalid', 'The demo selection is not a set of options.');
  }
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.prototype.hasOwnProperty.call(knobs, key)) {
      throw new GuestTemplateError('guest_variant_invalid', `The demo does not offer the "${key}" option.`);
    }
    const options = knobs[key] && knobs[key].options;
    if (typeof value !== 'string' || !options || !Object.prototype.hasOwnProperty.call(options, value)) {
      throw new GuestTemplateError('guest_variant_invalid', `That "${key}" option is not available in this demo.`);
    }
    merged[key] = value;
  }
  return merged;
}

function buildTokens(variantSpec, merged) {
  const tokens = {};
  for (const [key, spec] of Object.entries(variantSpec.knobs || {})) {
    const selected = merged[key];
    const optionValue = spec && spec.options ? spec.options[selected] : undefined;
    const upper = key.toUpperCase();
    // A knob whose option value is a string renders that string (an accent hex, a
    // mode label); one whose value is null renders the option key itself.
    tokens[upper] = typeof optionValue === 'string' ? optionValue : String(selected);
    tokens[`${upper}_NAME`] = String(selected);
    tokens[`${upper}_KEY`] = String(selected);
  }
  for (const [placeholder, spec] of Object.entries(variantSpec.derived || {})) {
    const selected = merged[spec.knob];
    tokens[placeholder] = (spec.values && Object.prototype.hasOwnProperty.call(spec.values, selected)
      ? spec.values[selected]
      : '') || '';
  }
  return tokens;
}

function substitute(text, tokens, file) {
  let out = text;
  for (let pass = 0; pass < MAX_SUBSTITUTION_PASSES; pass += 1) {
    out = out.replace(TOKEN_RE, (whole, name) => (Object.prototype.hasOwnProperty.call(tokens, name) ? tokens[name] : whole));
    if (!TOKEN_RE.test(out)) return out;
    TOKEN_RE.lastIndex = 0;
  }
  const leftover = [...out.matchAll(TOKEN_RE)].map((match) => match[1]);
  throw new GuestTemplateError('guest_template_invalid', `${file} references undefined tokens: ${[...new Set(leftover)].join(', ')}.`);
}

function matches(spec, merged) {
  if (!spec.when) return true;
  return Object.entries(spec.when).every(([knob, values]) => Array.isArray(values)
    && values.includes(merged[knob]));
}

/**
 * The release payload for one preview: every file the selected variant needs,
 * already rendered. `path` is relative to the preview's own directory, so the
 * deployer can drop the whole set under `/<token>/` without further reasoning.
 */
function buildGuestRelease({ template, variant } = {}) {
  const { name, deploy, variantSpec } = loadGuestTemplate(template);
  const merged = resolveVariant(variantSpec, variant);
  const tokens = { ...(deploy.tokens || {}), ...buildTokens(variantSpec, merged) };

  const chosen = deploy.files.filter((spec) => matches(spec, merged));
  const seen = new Map();
  for (const spec of chosen) {
    if (seen.has(spec.path)) {
      throw new GuestTemplateError('guest_template_invalid', `Template "${name}" maps two files to ${spec.path}.`);
    }
    seen.set(spec.path, spec);
  }

  const files = [...seen.entries()].map(([file, spec]) => {
    const source = resolveBundlePath(spec.src, name);
    let text;
    try {
      text = fs.readFileSync(source, 'utf8');
    } catch (_) {
      throw new GuestTemplateError('guest_template_missing', `Template "${name}" is missing ${spec.src}.`);
    }
    return { path: file, content: substitute(text, tokens, spec.src) };
  });

  return { template: name, label: deploy.label, variant: merged, files };
}

module.exports = {
  TEMPLATES,
  GuestTemplateError,
  loadGuestTemplate,
  buildGuestRelease,
  resolveVariant,
};
