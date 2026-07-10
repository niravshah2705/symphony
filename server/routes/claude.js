'use strict';

const express = require('express');
const { CONFIG } = require('../config');
const { getSettings, patchSettings, getClaudeTokens, setClaudeTokens, clearClaudeTokens } = require('../store');
const { asyncHandler, maskKey } = require('../util');
const claudeOauth = require('../agent/claude-oauth');
const { ensureFreshClaudeTokens, resolveLlm, createChatModel } = require('../agent/llm');
const { presetForModel } = require('../agent/model-presets');
const { discoverModels } = require('../agent/model-discovery');
const log = require('../logger');

/**
 * Claude (Anthropic) OAuth 2.0 Authorization Code + PKCE endpoints.
 *
 * Security posture (oauth-oidc checklist):
 *   - provider URLs + client id are trusted server-side config (CONFIG.CLAUDE),
 *     never read from the request;
 *   - PKCE S256 + a single-use, short-lived, server-issued `state` guard the
 *     exchange against CSRF and code injection — the state is echoed back inside
 *     the pasted `code#state` and matched against a login we issued;
 *   - tokens are stored server-side only and masked in responses.
 *
 * Flow: /login returns an authorize URL. The operator approves in the browser,
 * copies the `code#state` value Anthropic's callback page shows, and POSTs it to
 * /exchange. There is no local redirect callback (no loopback port to register).
 */

const router = express.Router();

/** Public (masked) view of the Claude provider state. */
function claudePublic() {
  const s = getSettings();
  const t = s.claudeTokens;
  const connected = Boolean(t && (t.accessToken || t.refreshToken));
  return {
    provider: s.llmProvider || 'ollama',
    connected,
    model: s.claudeModel || CONFIG.CLAUDE.defaultModel,
    configuredModel: s.claudeModel || '',
    defaultModel: CONFIG.CLAUDE.defaultModel,
    contextWindow: s.claudeContextWindow || 1000000,
    maxTokens: s.claudeMaxTokens || 65536,
    temperature: s.claudeTemperature ?? null,
    reasoningEffort: s.claudeReasoningEffort || 'none',
    baseUrl: CONFIG.CLAUDE.baseUrl,
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

// GET /api/settings/claude — masked status for the Settings page.
router.get('/', (req, res) => {
  res.json(claudePublic());
});

// GET /api/settings/claude/models — live account catalog with static fallback.
router.get(
  '/models',
  asyncHandler(async (req, res) => {
    res.json(await discoverModels('claude', { refresh: req.query.refresh === '1' }));
  })
);

// GET /api/settings/claude/login — begin OAuth; returns the authorize URL to open.
router.get('/login', (req, res) => {
  const { authorizeUrl } = claudeOauth.createLogin();
  res.json({ authorizeUrl });
});

// POST /api/settings/claude — save model + output-token budget (NOT provider URLs).
router.post('/', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const hasModelOverride = b.claudeModel !== undefined;
  const model = hasModelOverride ? String(b.claudeModel).trim() : current.claudeModel;
  if (hasModelOverride && model && (!/^[\w.:\-/]{1,100}$/.test(model) || model.includes('//'))) {
    return res.status(400).json({ error: 'Invalid model name.' });
  }
  const matchedPreset = presetForModel('claude', model);
  const modelChanged = hasModelOverride && model !== current.claudeModel;
  const currentPreset = presetForModel('claude', current.claudeModel);
  const modelFamilyChanged = hasModelOverride && (matchedPreset
    ? !currentPreset || currentPreset.id !== matchedPreset.id
    : modelChanged);
  const reasoningAdapter = matchedPreset
    ? matchedPreset.capabilities.reasoningAdapter
    : modelChanged ? 'none' : current.claudeReasoningAdapter || 'none';
  const reasoningEfforts = matchedPreset
    ? matchedPreset.capabilities.reasoningEfforts
    : reasoningAdapter === 'anthropic-adaptive' || reasoningAdapter === 'anthropic-effort'
      ? ['none', 'low', 'medium', 'high', 'xhigh', 'max']
      : ['none'];
  const defaultEffort = !modelFamilyChanged && reasoningEfforts.includes(current.claudeReasoningEffort)
    ? current.claudeReasoningEffort
    : matchedPreset ? matchedPreset.parameters.reasoning.effort : 'none';
  const defaultMaxTokens = matchedPreset && modelFamilyChanged
    ? matchedPreset.parameters.maxOutputTokens
    : modelFamilyChanged ? 4096 : current.claudeMaxTokens || 65536;
  const patch = {
    claudeMaxTokens: clampInt(b.claudeMaxTokens, 128, 128000, defaultMaxTokens),
    // Opus 4.8 rejects non-default sampling parameters; keep this explicit so a
    // generic UI never accidentally starts sending temperature.
    claudeTemperature: null,
    claudeReasoningEffort: reasoningEfforts.includes(b.claudeReasoningEffort) ? b.claudeReasoningEffort : defaultEffort,
    claudeReasoningAdapter: reasoningAdapter,
  };
  if (modelFamilyChanged) patch.claudeContextWindow = matchedPreset ? matchedPreset.parameters.contextWindow : 200000;
  if (current.llmProvider === 'claude') patch.hostedLlmPresetId = 'custom';
  if (hasModelOverride) patch.claudeModel = model;
  patchSettings(patch);
  res.json(claudePublic());
});

// DELETE /api/settings/claude — sign out: clear server-side tokens.
router.delete('/', (req, res) => {
  clearClaudeTokens();
  res.json(claudePublic());
});

// POST /api/settings/claude/exchange — finish OAuth with the pasted `code#state`.
router.post(
  '/exchange',
  asyncHandler(async (req, res) => {
    const raw = req.body && req.body.code;
    const { code, state } = claudeOauth.parseCodeInput(raw);
    // Validate + consume the state BEFORE touching the code (CSRF / replay guard).
    const login = claudeOauth.consumeLogin(state);
    if (!login) {
      return res.status(403).json({ error: 'Invalid or expired sign-in request. Start the sign-in again.' });
    }
    if (!code) {
      return res.status(400).json({ error: 'Missing authorization code. Paste the full value from the Anthropic page.' });
    }
    try {
      const tokens = await claudeOauth.exchangeCodeForTokens({ code, state, codeVerifier: login.codeVerifier });
      setClaudeTokens(tokens);
      log.info('Claude OAuth sign-in complete; tokens stored server-side.');
      return res.json(claudePublic());
    } catch (err) {
      log.error(`Claude token exchange failed: ${err && err.message ? err.message : err}`);
      return res.status(502).json({ error: 'Could not complete the token exchange. Please start the sign-in again.' });
    }
  })
);

// POST /api/settings/claude/test — verify the token works with a tiny real call.
router.post(
  '/test',
  asyncHandler(async (req, res) => {
    // Refresh if needed, then exercise the real path so auth + beta header + model
    // are all validated end-to-end.
    await ensureFreshClaudeTokens();
    const llm = await resolveLlm({ ...getSettings(), llmProvider: 'claude' });
    const msg = await createChatModel(llm).invoke('Reply with the single word: ok');
    const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : '';
    if (!text.trim()) {
      return res.status(502).json({ error: 'Provider returned an empty response.' });
    }
    res.json({ ok: true, model: llm.model });
  })
);

// Expose the pending-login count for diagnostics/tests (no secrets).
router.get('/_pending', (req, res) => res.json({ pending: claudeOauth.pendingCount() }));

module.exports = { router, claudePublic };
