'use strict';

/**
 * ARCHIVED — removed during gateway decoupling. Public legacy paths now return
 * explicit no-store HTTP 410 tombstones. NOT imported by the running gateway.
 *
 * This was the Codex (OpenAI) ChatGPT OAuth 2.0 Authorization Code + PKCE
 * browser redirect flow: `GET /api/settings/codex/login` returned an authorize
 * URL, and `GET /auth/callback` (the provider-registered redirect URI) validated
 * the single-use `state`, exchanged the code, and stored tokens server-side.
 *
 * Removed per request. Codex tokens are provisioned through a privileged
 * settings-service operator surface; active routes only read/validate them.
 * This file is historical context, not an active restoration plan. It was
 * mounted in index.js as:
 *     app.get('/auth/callback', codexCallback);
 *
 * Dependencies it used (from the gateway route module):
 *   const { createLogin, consumeLogin, exchangeCodeForTokens } = require('@ai-fleet/shared-core/agent/oauth');
 *   const { setCodexTokens, initStore, runWithWorkspaceContext, currentWorkspaceContext } = require('@ai-fleet/shared/store');
 *   const oauthLib = require('@ai-fleet/shared-core/agent/oauth');
 *   const log = require('@ai-fleet/shared/logger');
 */

// GET /api/settings/codex/login — begin OAuth; returns the authorize URL to navigate to.
function loginRoute(router, { createLogin, currentWorkspaceContext }) {
  router.get('/login', (req, res) => {
    const { authorizeUrl } = createLogin(currentWorkspaceContext());
    res.json({ authorizeUrl });
  });
}

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
function makeCallback({ asyncHandler, consumeLogin, exchangeCodeForTokens, setCodexTokens, initStore, runWithWorkspaceContext, log }) {
  return asyncHandler(async (req, res) => {
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
}

module.exports = { loginRoute, makeCallback, escapeHtml, page };
