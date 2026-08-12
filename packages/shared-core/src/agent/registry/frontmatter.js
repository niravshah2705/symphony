'use strict';

/**
 * Minimal SKILL.md front-matter parser (zero-dependency).
 *
 * SKILL.md files (Claude Code AND Codex) open with a `---` fenced YAML block
 * holding a small, well-defined set of keys, then a Markdown body. We deliberately
 * do NOT pull in a full YAML engine: `shared-core` is charter-bound to stay free of
 * heavy deps, and parsing untrusted third-party front-matter with a large engine is
 * needless attack surface. Instead this reads the bounded subset we actually use:
 *
 *   name: web-research
 *   description: One line, or a "quoted line".
 *   allowed-tools: Bash, Read           # comma string OR [inline, array] OR block list
 *   argument-hint: <topic>
 *   user-invocable: true                # boolean
 *   metadata:                           # one level of nesting (Codex)
 *     short-description: ...
 *
 * Everything parsed here is treated as INERT DATA — never executed. Unknown keys
 * are preserved verbatim so callers can inspect them; only the known keys are
 * interpreted (booleans, inline/comma arrays, one nested map level).
 */

/**
 * Split a document into its front-matter block and body.
 * @param {string} text
 * @returns {{ raw: string|null, body: string }} raw front-matter text (null if none)
 */
function splitFrontmatter(text) {
  const src = typeof text === 'string' ? text : '';
  // Must start with a `---` fence (allow a leading BOM / whitespace-only lines).
  const match = src.match(/^﻿?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!match) return { raw: null, body: src };
  return { raw: match[1], body: match[2] || '' };
}

/** Strip a trailing `# comment` that is not inside quotes, then trim. */
function stripComment(value) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\t')) {
      return value.slice(0, i);
    }
  }
  return value;
}

/** Coerce a scalar token: quotes stripped, booleans/null/numbers recognized. */
function coerceScalar(token) {
  const t = token.trim();
  if (t === '') return '';
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  const lower = t.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || lower === '~') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

/** Parse an inline flow array `[a, "b", c]` into an array of scalars. */
function parseInlineArray(token) {
  const inner = token.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return splitTopLevelCommas(inner).map((part) => coerceScalar(part));
}

/** Split on commas that are not inside quotes. */
function splitTopLevelCommas(str) {
  const parts = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of str) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ',' && !inSingle && !inDouble) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Indentation width (spaces) of a line. */
function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].replace(/\t/g, '  ').length : 0;
}

/**
 * Parse the bounded front-matter subset into a plain object. Supports scalars,
 * booleans, inline `[a, b]` arrays, `- item` block arrays, and ONE level of
 * nested mapping (`key:` with indented `child: value` lines).
 * @param {string} raw front-matter text (between the fences)
 * @returns {Record<string, unknown>}
 */
function parseBlock(raw) {
  const lines = String(raw).split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i += 1; continue; }
    if (indentOf(line) > 0) { i += 1; continue; } // stray indented line without a parent
    const colon = line.indexOf(':');
    if (colon === -1) { i += 1; continue; }
    const key = line.slice(0, colon).trim();
    const rest = stripComment(line.slice(colon + 1)).trim();
    if (rest === '') {
      // Either a nested map or a block array on following more-indented lines.
      const child = [];
      let j = i + 1;
      const childLines = [];
      while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > 0)) {
        if (lines[j].trim() !== '') childLines.push(lines[j]);
        j += 1;
      }
      if (childLines.length && childLines.every((l) => l.trim().startsWith('- '))) {
        for (const l of childLines) child.push(coerceScalar(stripComment(l.trim().slice(2))));
        data[key] = child;
      } else if (childLines.length) {
        const nested = {};
        for (const l of childLines) {
          const c = l.indexOf(':');
          if (c === -1) continue;
          nested[l.slice(0, c).trim()] = coerceScalar(stripComment(l.slice(c + 1)).trim());
        }
        data[key] = nested;
      } else {
        data[key] = '';
      }
      i = j;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = parseInlineArray(rest);
    } else {
      data[key] = coerceScalar(rest);
    }
    i += 1;
  }
  return data;
}

/**
 * Parse a SKILL.md document into `{ data, body }`.
 * @param {string} text
 * @returns {{ data: Record<string, unknown>, body: string }}
 */
function parseFrontmatter(text) {
  const { raw, body } = splitFrontmatter(text);
  return { data: raw == null ? {} : parseBlock(raw), body };
}

/** Normalize an allowed-tools value (string | array | comma-list) to string[]. */
function toToolList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return splitTopLevelCommas(String(value)).map((v) => coerceScalar(v)).map(String);
}

/**
 * Extract the harness-agnostic skill fields from parsed front-matter data.
 * @param {Record<string, unknown>} data
 * @returns {{ name: string|null, description: string, allowedTools: string[],
 *             argumentHint: string|null, userInvocable: boolean|null,
 *             shortDescription: string|null }}
 */
function skillFields(data) {
  const d = data || {};
  const metadata = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
  const short = metadata['short-description'] != null ? metadata['short-description'] : null;
  return {
    name: d.name != null ? String(d.name) : null,
    description: d.description != null ? String(d.description) : '',
    allowedTools: toToolList(d['allowed-tools']),
    argumentHint: d['argument-hint'] != null ? String(d['argument-hint']) : null,
    userInvocable: typeof d['user-invocable'] === 'boolean' ? d['user-invocable'] : null,
    shortDescription: short != null ? String(short) : null,
  };
}

module.exports = {
  splitFrontmatter,
  parseFrontmatter,
  skillFields,
  toToolList,
};
