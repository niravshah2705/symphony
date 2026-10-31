'use strict';

/**
 * Universal Skill Router module.
 * Provides latency-bounded, System 1 decision-based skill routing
 * using dedicated Laya or CLM inference services.
 */

const fs = require('fs');
const path = require('path');
const { CONFIG, resolveSkillsSrc } = require('../../config');
const { routeWithLaya } = require('./laya-client');
const { routeWithClm } = require('./clm-client');
const { routeWithLangChainRouter } = require('./langchain-adapter');
const { computeContextMetrics, measureSkillContextSize } = require('./metrics');

/**
 * Extract skill identifier, title, and description from a SKILL.md directory.
 * @param {string} skillPath
 * @param {string} [rootDir]
 * @returns {{ id: string, name: string, description: string, path: string } | null}
 */
function extractSkillMetadata(skillPath, rootDir = null) {
  if (!skillPath) return null;
  const normalized = String(skillPath).replace(/\/+$/, '');
  const id = path.basename(normalized);

  let targetFile = normalized;
  let description = id;

  try {
    let resolved = normalized;
    if (rootDir && !path.isAbsolute(normalized)) {
      if (normalized.startsWith('/')) {
        resolved = path.join(rootDir, normalized);
      } else {
        resolved = path.join(rootDir, '.agent-skills', normalized);
      }
    }
    if (!fs.existsSync(resolved) && typeof resolveSkillsSrc === 'function') {
      try {
        const cand = path.join(resolveSkillsSrc(), id);
        if (fs.existsSync(cand)) resolved = cand;
      } catch (_) {}
    }

    if (fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (stat.isDirectory()) {
        targetFile = path.join(resolved, 'SKILL.md');
      } else {
        targetFile = resolved;
      }
      if (fs.existsSync(targetFile)) {
        const content = fs.readFileSync(targetFile, 'utf8');
        const lines = content.split(/\r?\n/).slice(0, 30);
        for (const line of lines) {
          const descMatch = line.match(/^description:\s*(.+)/i)
            || line.match(/^#\s+(.+)/)
            || line.match(/^\>\s*(.+)/);
          if (descMatch && descMatch[1].trim()) {
            description = descMatch[1].trim();
            break;
          }
        }
      }
    }
  } catch (_) {
    // If unreadable, fallback to ID
  }

  return { id, name: id, description, path: skillPath };
}

/**
 * Route and shortlist skills for a prompt turn.
 * @param {string} prompt - User request or prompt text.
 * @param {string[]} availableSkillPaths - Candidate skill paths.
 * @param {object} [options] - Overrides for backend, topK, timeoutMs, rootDir.
 * @returns {Promise<{ selectedSkillPaths: string[], metrics: object }>}
 */
async function routeSkillsForTurn(prompt, availableSkillPaths = [], options = {}) {
  const routerConfig = CONFIG.skillRouter || {};
  const isEnabled = options.enabled !== undefined
    ? Boolean(options.enabled)
    : (routerConfig.enabled !== false && process.env.SKILL_ROUTER_ENABLED !== 'false');

  const backend = options.backend || routerConfig.backend || process.env.SKILL_ROUTER_BACKEND || 'laya';
  const timeoutMs = options.timeoutMs || routerConfig.timeoutMs || Number(process.env.SKILL_ROUTER_TIMEOUT_MS) || 150;
  const topK = options.topK || routerConfig.topK || Number(process.env.SKILL_ROUTER_TOP_K) || 3;
  const rootDir = options.rootDir || null;

  // Passthrough if disabled or negligible candidate pool
  if (!isEnabled || !Array.isArray(availableSkillPaths) || availableSkillPaths.length <= 1 || !prompt) {
    const metrics = computeContextMetrics(availableSkillPaths, availableSkillPaths, {
      backend: 'none',
      fallbackApplied: false,
      latencyMs: 0,
    }, rootDir);
    return { selectedSkillPaths: availableSkillPaths, metrics };
  }

  const candidates = availableSkillPaths.map((sp) => extractSkillMetadata(sp, rootDir)).filter(Boolean);
  const start = Date.now();
  let selectedIds = [];
  let fallbackApplied = false;

  try {
    if (backend === 'clm') {
      selectedIds = await routeWithClm(prompt, candidates, { timeoutMs, topK });
    } else if (backend === 'langchain') {
      selectedIds = await routeWithLangChainRouter(prompt, candidates, { timeoutMs, topK, backend: 'laya' });
    } else {
      // Default to Laya
      selectedIds = await routeWithLaya(prompt, candidates, { timeoutMs, topK });
    }
  } catch (error) {
    // Latency violation or network failure: fallback gracefully to all policy-allowed skills
    fallbackApplied = true;
    selectedIds = candidates.map((c) => c.id);
  }

  const latencyMs = Date.now() - start;

  let selectedPaths = availableSkillPaths;
  if (!fallbackApplied && Array.isArray(selectedIds) && selectedIds.length > 0) {
    const idSet = new Set(selectedIds);
    selectedPaths = availableSkillPaths.filter((sp) => {
      const clean = String(sp).replace(/\/+$/, '');
      return idSet.has(path.basename(clean));
    });
    // Ensure we never return an empty list if routing returned unknown IDs
    if (!selectedPaths.length) {
      selectedPaths = availableSkillPaths;
      fallbackApplied = true;
    }
  }

  const metrics = computeContextMetrics(availableSkillPaths, selectedPaths, {
    backend,
    fallbackApplied,
    latencyMs,
  }, rootDir);

  return {
    selectedSkillPaths: selectedPaths,
    metrics,
  };
}

module.exports = {
  routeSkillsForTurn,
  extractSkillMetadata,
  measureSkillContextSize,
  computeContextMetrics,
};
