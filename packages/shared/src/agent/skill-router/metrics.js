'use strict';

/**
 * Context size and token estimation metrics for skill routing.
 * Tracks total candidate skill size vs filtered skill size after routing.
 */

const fs = require('fs');
const path = require('path');

/**
 * Resolve a skill path or name to its target file on disk.
 * @param {string} sp
 * @param {string} [rootDir]
 * @returns {string}
 */
function resolveSkillPathOnDisk(sp, rootDir = null) {
  if (!sp) return '';
  const normalized = String(sp).trim();
  if (fs.existsSync(normalized)) return normalized;

  if (rootDir && !path.isAbsolute(normalized)) {
    const directRel = normalized.startsWith('/')
      ? path.join(rootDir, normalized)
      : path.join(rootDir, '.agent-skills', normalized);
    if (fs.existsSync(directRel)) return directRel;
  }

  try {
    const { resolveSkillsSrc } = require('../../../packages/shared-core/src/config');
    const cand = path.join(resolveSkillsSrc(), path.basename(normalized.replace(/\/+$/, '')));
    if (fs.existsSync(cand)) return cand;
  } catch (_) {}

  return normalized;
}

/**
 * Measure context size in characters and approximate tokens (~4 chars per token).
 * @param {string[]} skillPaths - Array of filesystem paths to skills or SKILL.md.
 * @param {string} [rootDir] - Workspace root directory if paths are relative.
 * @returns {{ charCount: number, estimatedTokens: number, skillCount: number }}
 */
function measureSkillContextSize(skillPaths = [], rootDir = null) {
  let charCount = 0;

  for (const sp of skillPaths) {
    if (!sp) continue;
    let target = resolveSkillPathOnDisk(sp, rootDir);
    try {
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (stat.isDirectory()) {
          target = path.join(target, 'SKILL.md');
        }
        if (fs.existsSync(target)) {
          const content = fs.readFileSync(target, 'utf8');
          charCount += content.length;
        }
      }
    } catch (_) {
      // Ignore missing or inaccessible paths in estimation
    }
  }

  const estimatedTokens = Math.ceil(charCount / 4);
  return {
    charCount,
    estimatedTokens,
    skillCount: skillPaths.length,
  };
}

/**
 * Compute context savings metrics between candidate set and routed set.
 * @param {string[]} allSkillPaths
 * @param {string[]} routedSkillPaths
 * @param {object} meta
 * @param {string} [rootDir]
 * @returns {object}
 */
function computeContextMetrics(allSkillPaths = [], routedSkillPaths = [], meta = {}, rootDir = null) {
  const before = measureSkillContextSize(allSkillPaths, rootDir);
  const after = measureSkillContextSize(routedSkillPaths, rootDir);

  const totalContextSize = before.charCount;
  const usedContextSize = after.charCount;
  const savedContextSize = Math.max(0, totalContextSize - usedContextSize);
  const reductionPercent = totalContextSize > 0
    ? Number(((savedContextSize / totalContextSize) * 100).toFixed(1))
    : 0.0;

  return {
    backend: meta.backend || 'unknown',
    fallbackApplied: Boolean(meta.fallbackApplied),
    routingLatencyMs: meta.latencyMs || 0,
    totalSkills: before.skillCount,
    usedSkills: after.skillCount,
    totalContextSize, // characters
    usedContextSize,  // characters
    savedContextSize, // characters
    contextReductionPercent: reductionPercent,
    estimatedTokensTotal: before.estimatedTokens,
    estimatedTokensUsed: after.estimatedTokens,
    estimatedTokensSaved: Math.max(0, before.estimatedTokens - after.estimatedTokens),
  };
}

module.exports = {
  measureSkillContextSize,
  computeContextMetrics,
};
