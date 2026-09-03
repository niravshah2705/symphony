'use strict';

/**
 * Serialize/parse a single memory as a Markdown file with a YAML front-matter
 * block (frontmatter = metadata, body = the memory text). Reuses the shared-core
 * zero-dependency SKILL.md front-matter PARSER (`registry/frontmatter.js`); the
 * serializer is a tiny local writer for the bounded key set we control.
 *
 * Everything here is INERT DATA — the memory text is agent-generated prose that
 * is never executed. Values are conservatively double-quoted on write so a title
 * or timestamp containing `:` / `#` / brackets round-trips cleanly.
 */

const { parseFrontmatter } = require('@ai-fleet/shared-core/agent/registry/frontmatter');

/** Double-quote + escape any scalar that could confuse the front-matter reader. */
function yamlScalar(value) {
  const s = String(value == null ? '' : value);
  if (s === '' || /^[\s]|[\s]$|[:#[\]{}",\n]/.test(s) || /^(true|false|null|~|-?\d+)$/i.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Render a memory record as `---\n<frontmatter>\n---\n\n<text>\n`. */
function serializeMemoryFile(record) {
  const r = record || {};
  const lines = ['---'];
  lines.push(`id: ${yamlScalar(r.id)}`);
  lines.push(`scope: ${yamlScalar(r.scope)}`);
  lines.push(`title: ${yamlScalar(r.title)}`);
  if (r.refId) lines.push(`refId: ${yamlScalar(r.refId)}`);
  lines.push(`source: ${yamlScalar(r.source || 'agent')}`);
  lines.push(`createdAt: ${yamlScalar(r.createdAt)}`);
  if (Array.isArray(r.tags) && r.tags.length) {
    lines.push(`tags: [${r.tags.map(yamlScalar).join(', ')}]`);
  }
  lines.push('---');
  lines.push('');
  lines.push(String(r.text || ''));
  lines.push('');
  return lines.join('\n');
}

/** Parse a memory file back into a record. Returns nulls for absent fields. */
function parseMemoryFile(text) {
  const { data, body } = parseFrontmatter(text);
  const tags = Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [];
  return {
    id: data.id != null ? String(data.id) : null,
    scope: data.scope != null ? String(data.scope) : null,
    title: data.title != null ? String(data.title) : '',
    refId: data.refId != null ? String(data.refId) : null,
    source: data.source != null ? String(data.source) : 'agent',
    createdAt: data.createdAt != null ? String(data.createdAt) : null,
    tags,
    text: String(body || '').trim(),
  };
}

module.exports = { serializeMemoryFile, parseMemoryFile, yamlScalar };
