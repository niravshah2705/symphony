'use strict';

/**
 * Global catalog — the platform-wide component list the workflow designer
 * populates its dropdowns from: current harness runtime images, plugin
 * bundles and skill bundles. The three shipped source-of-truth files are the
 * data (the same ones CI stamps and the seed script mirrors), so the designer
 * never invents a name the publish would refuse.
 */

const fs = require('node:fs');
const path = require('node:path');

const pluginCatalog = require('./registry/plugin-catalog.json');
const skillCatalog = require('./registry/skill-catalog.json');
const agentCardTags = require('./registry/agent-card-tags.json');

const RUNTIME_CSV = path.join(__dirname, '..', '..', '..', '..', 'go', 'harness', 'runtime-images.csv');

function parseRuntimeCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return [];
  const header = lines[0].split(',').map((cell) => cell.trim());
  const at = (name) => header.indexOf(name);
  const required = ['runtime', 'image', 'version', 'current'];
  if (required.some((name) => at(name) === -1)) return [];
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((cell) => cell.trim());
    return {
      runtime: cells[at('runtime')],
      image: cells[at('image')],
      version: cells[at('version')],
      current: cells[at('current')] === 'true',
    };
  });
}

function currentRuntimes(csvPath = RUNTIME_CSV) {
  let text = '';
  try { text = fs.readFileSync(csvPath, 'utf8'); } catch (_) { return []; }
  return parseRuntimeCsv(text).filter((row) => row.current);
}

/**
 * The immutable kagent artifact source for one pack. Only the published OCI
 * digest qualifies — the upstream git pin names the author's repo, not the
 * bundle kagent would pull — so an unstamped pack gets null and the designer
 * shows it as "not published yet" rather than binding a source that cannot
 * resolve.
 */
function packSource({ image, digest }) {
  if (image && digest) {
    const pinned = String(digest).startsWith('sha256:') ? String(digest) : `sha256:${String(digest)}`;
    if (/^sha256:[0-9a-f]{64}$/.test(pinned)) return { oci: `${image}@${pinned}` };
  }
  if (image && /@sha256:[0-9a-f]{64}$/.test(String(image))) return { oci: String(image) };
  return null;
}

function globalCatalog() {
  const tagsFor = (id) => (agentCardTags.tags || {})[id] || [];
  const harnesses = currentRuntimes().map(({ runtime, image, version }) => ({ runtime, image, version }));
  const plugins = (pluginCatalog.plugins || []).map((record) => {
    const bundle = record.bundle || {};
    const upstream = record.upstream || {};
    return {
      id: record.id,
      label: record.label || record.id,
      version: bundle.version || upstream.release || '',
      image: bundle.image || '',
      digest: bundle.digest || null,
      skills: (record.skills || []).map((skill) => skill.name),
      skillsDir: bundle.skillsDir || '',
      tags: tagsFor(record.id),
      promptAppend: record.promptAppend || '',
      source: packSource({
        image: bundle.image,
        digest: bundle.digest,
      }),
    };
  });
  const skills = (skillCatalog.skills || []).map((record) => {
    const artifact = record.artifact || {};
    const upstream = record.upstream || {};
    return {
      id: record.id,
      label: record.label || record.id,
      version: artifact.version || '',
      image: artifact.image || '',
      digest: artifact.digest || null,
      path: artifact.skillPath || '',
      tags: tagsFor(record.id),
      promptAppend: record.promptAppend || '',
      source: packSource({
        image: artifact.image,
        digest: artifact.digest,
      }),
    };
  });
  return {
    harnesses,
    plugins,
    skills,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { globalCatalog, currentRuntimes, parseRuntimeCsv, packSource };
