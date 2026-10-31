'use strict';

/**
 * Adapter implementing the langchain-skill-router protocol for DeepAgent.
 * Provides per-turn progressive disclosure of skills to avoid context bloat.
 */

const { routeWithLaya } = require('./laya-client');
const { routeWithClm } = require('./clm-client');

class LangChainSkillRouter {
  constructor(options = {}) {
    this.backend = options.backend || 'laya';
    this.topK = options.topK || 3;
    this.timeoutMs = options.timeoutMs || 150;
    this.fallbackOnTimeout = options.fallbackOnTimeout !== false;
  }

  /**
   * Route skills for a given conversation turn.
   * @param {string} turnPrompt - User input or turn instruction.
   * @param {Array<{id: string, name?: string, description: string, path: string}>} candidates
   * @returns {Promise<string[]>} - Array of selected skill IDs.
   */
  async routeTurn(turnPrompt, candidates = []) {
    if (!candidates.length || !turnPrompt) {
      return candidates.map((c) => c.id);
    }

    if (this.backend === 'clm') {
      return routeWithClm(turnPrompt, candidates, {
        topK: this.topK,
        timeoutMs: this.timeoutMs,
      });
    }

    // Default to Laya decision router
    return routeWithLaya(turnPrompt, candidates, {
      topK: this.topK,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * LangChain Runnable invoke protocol.
   * @param {{ prompt?: string, input?: string, candidates?: Array, routingFn?: Function } | string} input
   * @param {object} [config]
   * @returns {Promise<{ selectedSkillIds: string[], fallbackApplied: boolean }>}
   */
  async invoke(input = {}, config = {}) {
    const prompt = typeof input === 'string' ? input : (input.prompt || input.input || '');
    const candidates = (typeof input === 'object' && input.candidates) || [];
    const routingFn = (typeof input === 'object' && input.routingFn) || config.routingFn;

    if (typeof routingFn === 'function') {
      const selected = await routingFn(prompt, candidates, {
        topK: this.topK,
        timeoutMs: this.timeoutMs,
      });
      return {
        selectedSkillIds: selected,
        fallbackApplied: false,
      };
    }

    try {
      const selected = await this.routeTurn(prompt, candidates);
      return {
        selectedSkillIds: selected,
        fallbackApplied: false,
      };
    } catch (err) {
      if (this.fallbackOnTimeout) {
        return {
          selectedSkillIds: candidates.map((c) => c.id),
          fallbackApplied: true,
          error: err.message,
        };
      }
      throw err;
    }
  }
}

async function routeWithLangChainRouter(prompt, candidates = [], options = {}) {
  const router = new LangChainSkillRouter(options);
  return router.routeTurn(prompt, candidates);
}

module.exports = {
  LangChainSkillRouter,
  routeWithLangChainRouter,
};
