'use strict';

/**
 * Model families — the vocabulary the workflow designer's "Model family"
 * field offers, and the list the graph validator checks a saved family
 * against.
 *
 * The registry file is the source of truth (see registry/model-families.json):
 * adding a family is a data edit, not a change to four hardcoded arrays. It is
 * served to the browser through `globalCatalog()` and read here on the write
 * path, so the parse is cached for the life of the process — a deploy restarts
 * it. A missing or unreadable file degrades to an empty vocabulary rather than
 * throwing: the graph write path must not fail because a catalog could not be
 * read, and `isKnownModelFamily` staying false only makes validation
 * permissive (see `normalizeModelFamily`).
 */

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_FILE = path.join(__dirname, 'registry', 'model-families.json');
// A family id becomes a label in a CR and a key in the UI, so it stays a DNS label.
const FAMILY_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DEFAULT_ICON = 'byom';
const LABEL_MAX = 80;
const ICON_MAX = 32;

function cleanName(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return FAMILY_NAME.test(text) && text.length <= 63 ? text : '';
}

function normalizeRecord(raw, index, problems, seen) {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = cleanName(record.id);
  if (!id) {
    problems.push(`family #${index + 1}: missing or malformed id — skipped`);
    return null;
  }
  if (seen.has(id)) {
    problems.push(`family "${id}": duplicate id — skipped`);
    return null;
  }
  seen.add(id);
  const label = String(record.label || '').trim().slice(0, LABEL_MAX) || id;
  const icon = String(record.icon || '').trim().slice(0, ICON_MAX) || DEFAULT_ICON;
  const providers = [];
  for (const provider of Array.isArray(record.providers) ? record.providers : []) {
    const name = cleanName(provider);
    if (!name) {
      problems.push(`family "${id}": provider ${JSON.stringify(provider)} is not a DNS label — dropped`);
      continue;
    }
    if (!providers.includes(name)) providers.push(name);
  }
  const order = Number.isFinite(Number(record.order)) ? Number(record.order) : (index + 1) * 10;
  return { id, label, icon, providers, order, enabled: record.enabled !== false };
}

function normalize(source) {
  const problems = [];
  if (!source || typeof source !== 'object' || !Array.isArray(source.families)) {
    return { families: [], problems: ['registry/model-families.json has no "families" array'] };
  }
  const seen = new Set();
  const families = source.families
    .map((raw, index) => normalizeRecord(raw, index, problems, seen))
    .filter(Boolean)
    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  if (!families.length) problems.push('registry/model-families.json carries no usable family');
  return { families, problems };
}

function load(filePath = REGISTRY_FILE) {
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (error) {
    return { families: [], problems: [`registry/model-families.json could not be read: ${error.code || error.message}`] };
  }
  let source = null;
  try { source = JSON.parse(text); } catch (error) {
    return { families: [], problems: [`registry/model-families.json is not valid JSON: ${error.message}`] };
  }
  return normalize(source);
}

let cache = null;
function loaded() {
  if (!cache) cache = load();
  return cache;
}

/** Every family the file declares, sorted for display, including disabled ones. */
function modelFamilies() {
  return loaded().families;
}

/** Parse/skip notes for the current file — empty when the registry is clean. */
function modelFamilyProblems() {
  return loaded().problems;
}

/**
 * Validate one saved family: a listed id (even a disabled one, so an existing
 * graph round-trips) or any well-formed name, which a row that was removed
 * from the file leaves behind. Only a value that could never be an id is
 * stripped — the same rule `harness` follows.
 */
function normalizeModelFamily(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase().slice(0, 63);
  if (!text) return '';
  return modelFamilies().some((family) => family.id === text) || FAMILY_NAME.test(text) ? text : '';
}

function isKnownModelFamily(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return Boolean(text) && modelFamilies().some((family) => family.id === text);
}

/** The family a preset provider belongs to, or null when nothing claims it. */
function familyForProvider(provider) {
  const name = String(provider == null ? '' : provider).trim().toLowerCase();
  if (!name) return null;
  return modelFamilies().find((family) => family.providers.includes(name)) || null;
}

module.exports = {
  REGISTRY_FILE,
  FAMILY_NAME,
  load,
  normalize,
  modelFamilies,
  modelFamilyProblems,
  normalizeModelFamily,
  isKnownModelFamily,
  familyForProvider,
};
