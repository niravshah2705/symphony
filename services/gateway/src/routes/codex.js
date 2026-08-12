'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const {
  getSettings,
  patchSettings,
  getCodexTokens,
  setCodexTokens,
  clearCodexTokens,
  initStore,
  runWithWorkspaceContext,
  currentWorkspaceContext,
} = require('@ai-fleet/shared/store');
const { asyncHandler, maskKey } = require('@ai-fleet/shared/util');
const { createLogin, consumeLogin, exchangeCodeForTokens } = require('@ai-fleet/shared-core/agent/oauth');
const { ensureFreshCodexTokens } = require('@ai-fleet/shared/agent/llm');
const { presetForModel } = require('@ai-fleet/shared-core/agent/model-presets');
const { discoverModels } = require('@ai-fleet/shared/agent/model-discovery');
const oauthLib = require('@ai-fleet/shared-core/agent/oauth');
const log = require('@ai-fleet/shared/logger');

/**
 * Codex (OpenAI) OAuth 2.0 Authorization Code + PKCE endpoints.
 *
 * Security posture (oauth-oidc checklist):
 *   - provider URLs + client id are trusted server-side config (CONFIG.OAUTH),
 *     never read from the request;
 *   - PKCE S256 + a single-use, short-lived, server-issued `state` guard the
 *     callback against CSRF and code injection;
 *   - the authorization code is exchanged once, bound to the same redirect_uri
 *     and verifier; tokens are stored server-side only and masked in responses.
 */

const router = express.Router();

/** Effective base URL + default model for the configured Codex backend. */
function backendDefaults() {
  const chatgpt = CONFIG.OAUTH.backend === 'chatgpt';
  return {
    backend: CONFIG.OAUTH.backend,
    baseUrl: chatgpt ? CONFIG.OAUTH.chatgptBaseUrl : CONFIG.OAUTH.baseUrl,
    defaultModel: chatgpt ? CONFIG.OAUTH.chatgptModel : CONFIG.OAUTH.defaultModel,
  };
}

/** Public (masked) view of the Codex provider state. */
function codexPublic() {
  const s = getSettings();
  const t = s.codexTokens;
  const connected = Boolean(t && (t.accessToken || t.refreshToken));
  const { backend, baseUrl, defaultModel } = backendDefaults();
  return {
    provider: s.llmProvider || 'ollama',
    connected,
    backend,
    model: s.codexModel || defaultModel,
    configuredModel: s.codexModel || '',
    defaultModel,
    contextWindow: s.codexContextWindow || 1000000,
    maxTokens: s.codexMaxTokens || 65536,
    temperature: s.codexTemperature ?? null,
    reasoningEffort: s.codexReasoningEffort || 'none',
    baseUrl,
    redirectUri: CONFIG.OAUTH.redirectUri,
    maskedToken: connected ? maskKey(t.accessToken || '') : '',
    expiresAt: connected ? t.expiresAt || null : null,
    scope: connected ? t.scope || '' : '',
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// GET /api/settings/codex — masked status for the Settings page.
router.get('/', (req, res) => {
  res.json(codexPublic());
});

// GET /api/settings/codex/models — live account catalog with static fallback.
router.get(
  '/models',
  asyncHandler(async (req, res) => {
    res.json(await discoverModels('codex', { refresh: req.query.refresh === '1' }));
  })
);

// GET /api/settings/codex/login — begin OAuth; returns the authorize URL to navigate to.
router.get('/login', (req, res) => {
  const { authorizeUrl } = createLogin(currentWorkspaceContext());
  res.json({ authorizeUrl });
});

// POST /api/settings/codex — save model + output-token budget (NOT provider URLs).
router.post('/', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const hasModelOverride = b.codexModel !== undefined;
  const model = hasModelOverride ? String(b.codexModel).trim() : current.codexModel;
  if (hasModelOverride && model && (!/^[\w.:\-/]{1,100}$/.test(model) || model.includes('//'))) {
    return res.status(400).json({ error: 'Invalid model name.' });
  }
  const matchedPreset = presetForModel('codex', model);
  const modelChanged = hasModelOverride && model !== current.codexModel;
  const currentPreset = presetForModel('codex', current.codexModel);
  const modelFamilyChanged = hasModelOverride && (matchedPreset
    ? !currentPreset || currentPreset.id !== matchedPreset.id
    : modelChanged);
  const reasoningAdapter = matchedPreset
    ? matchedPreset.capabilities.reasoningAdapter
    : modelChanged ? 'none' : current.codexReasoningAdapter || 'none';
  const reasoningEfforts = matchedPreset
    ? matchedPreset.capabilities.reasoningEfforts.filter(
      (effort) => CONFIG.OAUTH.backend === 'chatgpt' || effort !== 'ultra'
    )
    : reasoningAdapter === 'openai'
      ? CONFIG.OAUTH.backend === 'chatgpt'
        ? ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        : ['none', 'low', 'medium', 'high', 'xhigh', 'max']
      : ['none'];
  const defaultEffort = !modelFamilyChanged && reasoningEfforts.includes(current.codexReasoningEffort)
    ? current.codexReasoningEffort
    : matchedPreset ? matchedPreset.parameters.reasoning.effort : 'none';
  const defaultMaxTokens = matchedPreset && modelFamilyChanged
    ? matchedPreset.parameters.maxOutputTokens
    : modelFamilyChanged ? 4096 : current.codexMaxTokens || 65536;
  const patch = {
    codexMaxTokens: clampInt(b.codexMaxTokens, 128, 128000, defaultMaxTokens),
    codexTemperature: reasoningAdapter === 'none'
      ? clampNumber(b.codexTemperature, 0, 2, current.codexTemperature ?? null)
      : null,
    codexReasoningEffort: reasoningEfforts.includes(b.codexReasoningEffort) ? b.codexReasoningEffort : defaultEffort,
    codexReasoningAdapter: reasoningAdapter,
  };
  if (modelFamilyChanged) patch.codexContextWindow = matchedPreset ? matchedPreset.parameters.contextWindow : 128000;
  if (current.llmProvider === 'codex') patch.hostedLlmPresetId = 'custom';
  if (hasModelOverride) patch.codexModel = model;
  patchSettings(patch);
  res.json(codexPublic());
});

// DELETE /api/settings/codex — sign out: clear server-side tokens.
router.delete('/', (req, res) => {
  clearCodexTokens();
  res.json(codexPublic());
});

// POST /api/settings/codex/test — verify the token works against the active backend.
router.post(
  '/test',
  asyncHandler(async (req, res) => {
    // Exercise the real generation path so auth, model selection, and Responses
    // request compatibility are validated together.
    if (CONFIG.OAUTH.backend === 'chatgpt') {
      const { resolveLlm, createChatModel } = require('@ai-fleet/shared/agent/llm');
      const llm = await resolveLlm({ ...getSettings(), llmProvider: 'codex' });
      const msg = await createChatModel(llm).invoke('Reply with the single word: ok');
      const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : '';
      if (!text.trim()) {
        return res.status(502).json({ error: 'Provider returned an empty response.' });
      }
      return res.json({ ok: true, model: llm.model });
    }
    // Metered API: a cheap authenticated GET against /models.
    const tokens = await ensureFreshCodexTokens();
    const resp = await fetch(`${CONFIG.OAUTH.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return res.status(502).json({ error: `Provider rejected the token (HTTP ${resp.status}).` });
    }
    const data = await resp.json().catch(() => ({}));
    const count = Array.isArray(data.data) ? data.data.length : null;
    res.json({ ok: true, models: count });
  })
);

/* ------------------------------ callback -------------------------------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(res, status, title, message) {
  const backLink = '<p><a href="/#/settings">Return to AI Fleet settings</a></p>';
  res.status(status).type('html').send(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      '<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#111}' +
      'h1{font-size:20px}a{color:#2563eb}</style></head><body>' +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${backLink}</body></html>`
  );
}

/**
 * OAuth redirect handler. Mounted at the server-registered redirect URI
 * (`/auth/callback`). Validates state (single-use), then exchanges the code.
 */
const callback = asyncHandler(async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    log.warn(`Codex OAuth error: ${error}`);
    return page(res, 400, 'Sign-in failed', String(errorDescription || error));
  }

  // Validate + consume the state BEFORE touching the code (CSRF / replay guard).
  const login = consumeLogin(typeof state === 'string' ? state : '');
  if (!login) {
    return page(res, 403, 'Sign-in failed', 'Invalid or expired sign-in request. Please start again.');
  }
  if (!code || typeof code !== 'string') {
    return page(res, 400, 'Sign-in failed', 'Missing authorization code.');
  }

  return runWithWorkspaceContext(login.workspaceContext || {}, async () => {
    try {
      // The redirect has no selected-context headers. Re-enter the exact
      // workspace captured in the single-use state before hydrating or writing.
      await initStore();
      const tokens = await exchangeCodeForTokens({
        code,
        codeVerifier: login.codeVerifier,
        redirectUri: login.redirectUri, // exact redirect_uri reuse
      });
      setCodexTokens(tokens);
      log.info('Codex OAuth sign-in complete; tokens stored server-side.');
      return page(res, 200, 'Signed in to Codex', 'You can close this tab and return to AI Fleet.');
    } catch (err) {
      log.error(`Codex token exchange failed: ${err && err.message ? err.message : err}`);
      return page(res, 502, 'Sign-in failed', 'Could not complete the token exchange. Please try again.');
    }
  });
});

// Expose the pending-login count for diagnostics/tests (no secrets).
router.get('/_pending', (req, res) => res.json({ pending: oauthLib.pendingCount() }));

module.exports = { router, callback, codexPublic };
