'use strict';

const express = require('express');
const { getApiKey, setApiKey, getSettings, patchSettings } = require('../store');
const { getViewer } = require('../linear');
const { asyncHandler, maskKey } = require('../util');
const { CONFIG } = require('../config');

const router = express.Router();

/** Public settings view — secrets are masked, never returned raw. */
function publicSettings() {
  const s = getSettings();
  return {
    hasKey: Boolean(s.linearApiKey),
    maskedKey: maskKey(s.linearApiKey),
    // Active deep-agent provider: 'ollama' / 'lmstudio' (local) or 'codex' / 'claude' (OAuth).
    llmProvider: s.llmProvider || 'ollama',
    ollamaHost: s.ollamaHost,
    ollamaModel: s.ollamaModel,
    ollamaContextWindow: s.ollamaContextWindow,
    ollamaNumTokens: s.ollamaNumTokens,
    ollamaJsonMode: s.ollamaJsonMode || 'json',
    // LM Studio (local, OpenAI-compatible) — an alternative local provider.
    lmstudioHost: s.lmstudioHost,
    lmstudioModel: s.lmstudioModel,
    lmstudioContextWindow: s.lmstudioContextWindow,
    lmstudioNumTokens: s.lmstudioNumTokens,
    lmstudioJsonMode: s.lmstudioJsonMode || 'text',
    hasGithubToken: Boolean(s.githubToken),
    maskedGithubToken: maskKey(s.githubToken),
    hasLangsmithKey: Boolean(s.langsmithApiKey),
    maskedLangsmithKey: maskKey(s.langsmithApiKey),
    langsmithProject: s.langsmithProject,
    langsmithEndpoint: s.langsmithEndpoint,
    langsmithTracing: Boolean(s.langsmithTracing),
  };
}

/**
 * Validate an operator-supplied local inference host (Ollama or LM Studio). This
 * is a local single-user tool, so localhost is the intended target (unlike a
 * public SSRF sink). We only enforce a well-formed http/https URL; the host is
 * stored server-side and is never taken from a request parameter at call time.
 */
function normalizeHost(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
  } catch (_) {
    return fallback;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Keep `value` only if it is one of `allowed`, else fall back. */
function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// GET /api/settings
router.get('/', (req, res) => {
  res.json(publicSettings());
});

// PUT /api/settings — validate the Linear key against Linear, then persist.
router.put(
  '/',
  asyncHandler(async (req, res) => {
    const linearApiKey = (req.body && req.body.linearApiKey ? String(req.body.linearApiKey) : '').trim();
    if (!linearApiKey) {
      return res.status(400).json({ error: 'A Linear API key is required.' });
    }
    const { viewer, organization } = await getViewer(linearApiKey);
    setApiKey(linearApiKey);
    res.json({ ...publicSettings(), viewer, organization });
  })
);

// PUT /api/settings/llm — save the local Ollama configuration for the deep agent.
// Provider selection is separate (PUT /api/settings/provider), so saving Ollama
// settings does not silently switch an operator off the Codex provider.
router.put('/llm', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const patch = {
    ollamaHost: normalizeHost(b.ollamaHost, current.ollamaHost),
    ollamaContextWindow: clampInt(b.ollamaContextWindow, 512, 131072, current.ollamaContextWindow),
    ollamaNumTokens: clampInt(b.ollamaNumTokens, 128, 32768, current.ollamaNumTokens),
    ollamaJsonMode: oneOf(b.ollamaJsonMode, CONFIG.OLLAMA_JSON_MODES, current.ollamaJsonMode || 'json'),
  };
  if (b.ollamaModel !== undefined) patch.ollamaModel = String(b.ollamaModel).trim();
  patchSettings(patch);
  res.json(publicSettings());
});

// PUT /api/settings/lmstudio — save the local LM Studio configuration for the deep
// agent. Like Ollama, this is a local provider; provider selection stays separate
// (PUT /api/settings/provider), so saving LM Studio settings does not switch the
// active provider.
router.put('/lmstudio', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const patch = {
    lmstudioHost: normalizeHost(b.lmstudioHost, current.lmstudioHost),
    lmstudioContextWindow: clampInt(b.lmstudioContextWindow, 512, 131072, current.lmstudioContextWindow),
    lmstudioNumTokens: clampInt(b.lmstudioNumTokens, 128, 32768, current.lmstudioNumTokens),
    lmstudioJsonMode: oneOf(b.lmstudioJsonMode, CONFIG.LMSTUDIO_JSON_MODES, current.lmstudioJsonMode || 'text'),
  };
  if (b.lmstudioModel !== undefined) patch.lmstudioModel = String(b.lmstudioModel).trim();
  patchSettings(patch);
  res.json(publicSettings());
});

// PUT /api/settings/provider — choose the active deep-agent LLM provider.
router.put('/provider', (req, res) => {
  const requested = String((req.body && req.body.llmProvider) || '').trim();
  if (!CONFIG.LLM_PROVIDERS.includes(requested)) {
    return res.status(400).json({ error: `Provider must be one of: ${CONFIG.LLM_PROVIDERS.join(', ')}.` });
  }
  patchSettings({ llmProvider: requested });
  res.json(publicSettings());
});

// PUT /api/settings/github — save the GitHub token for the code-writer's git ops.
// Stored server-side only; never returned raw or logged. Empty string clears it.
router.put('/github', (req, res) => {
  const b = req.body || {};
  if (b.githubToken !== undefined) {
    patchSettings({ githubToken: String(b.githubToken).trim() });
  }
  res.json(publicSettings());
});

// PUT /api/settings/langsmith — save LangSmith tracing configuration.
router.put('/langsmith', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.langsmithApiKey !== undefined) patch.langsmithApiKey = String(b.langsmithApiKey).trim();
  if (b.langsmithProject !== undefined && String(b.langsmithProject).trim()) {
    patch.langsmithProject = String(b.langsmithProject).trim();
  }
  if (b.langsmithEndpoint !== undefined && String(b.langsmithEndpoint).trim()) {
    patch.langsmithEndpoint = String(b.langsmithEndpoint).trim();
  }
  if (b.langsmithTracing !== undefined) patch.langsmithTracing = Boolean(b.langsmithTracing);
  patchSettings(patch);
  res.json(publicSettings());
});

// GET /api/settings/validate — test the currently stored Linear key.
router.get(
  '/validate',
  asyncHandler(async (req, res) => {
    const key = getApiKey();
    if (!key) return res.status(400).json({ error: 'No API key configured.' });
    const { viewer, organization } = await getViewer(key);
    res.json({ ok: true, viewer, organization });
  })
);

// DELETE /api/settings — clear the Linear key.
router.delete('/', (req, res) => {
  setApiKey('');
  res.json(publicSettings());
});

module.exports = router;
