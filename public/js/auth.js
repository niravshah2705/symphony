import { createAuth0Client } from '/vendor/auth0-spa-js.js';
import { api, setAccessTokenProvider } from './api.js';

const AUTH_SESSION_TIMEOUT_MS = 15_000;

let client = null;
let configuration = null;
let authState = Object.freeze({
  mode: 'loading',
  enabled: false,
  authenticated: false,
  user: null,
  error: '',
});

function setState(next) {
  authState = Object.freeze({ ...authState, ...next });
  return authState;
}

async function withinSessionTimeout(operation) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error('Authentication session restoration timed out.')), AUTH_SESSION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }
}

function authorizationParams() {
  const params = {
    audience: configuration.auth0.audience,
    scope: configuration.auth0.scope,
    redirect_uri: configuration.auth0.redirectUri,
  };
  if (configuration.auth0.organization) params.organization = configuration.auth0.organization;
  return params;
}

async function loadConfiguration() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  let response;
  try {
    response = await fetch('/api/auth/config', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Authentication configuration timed out.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    // The error below is intentionally stable and does not expose proxy HTML.
  }
  if (!response.ok) throw new Error(payload.error || 'Authentication configuration could not be loaded.');
  if (!payload.enabled || payload.mode === 'disabled') return { mode: 'disabled', enabled: false };
  const auth0 = payload.auth0 || {};
  if (payload.mode !== 'istio' || !auth0.domain || !auth0.clientId || !auth0.audience || !auth0.redirectUri) {
    throw new Error('Authentication configuration is incomplete.');
  }
  return payload;
}

function cleanCallbackUrl(returnTo = '') {
  if (typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
    window.history.replaceState({}, document.title, returnTo);
    return;
  }
  const url = new URL(window.location.href);
  for (const name of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(name);
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

async function handleAuth0Callback() {
  const query = new URLSearchParams(window.location.search);
  if (query.has('error') && query.has('state')) {
    const description = String(query.get('error_description') || query.get('error') || '').slice(0, 300);
    cleanCallbackUrl();
    throw new Error(description || 'Auth0 sign-in was not completed.');
  }
  if (!query.has('code') || !query.has('state')) return;
  const result = await client.handleRedirectCallback();
  cleanCallbackUrl(result?.appState?.returnTo);
}

function mergeDisplayProfile(serverUser, browserUser) {
  const authoritative = serverUser || {};
  const display = browserUser || {};
  return Object.freeze({
    ...authoritative,
    name: authoritative.name || display.name || display.nickname || '',
    email: authoritative.email || display.email || '',
  });
}

export async function initializeAuthentication() {
  configuration = await loadConfiguration();
  if (!configuration.enabled) {
    client = null;
    setAccessTokenProvider(null);
    return setState({
      mode: 'disabled',
      enabled: false,
      authenticated: true,
      user: null,
      error: '',
    });
  }

  client = await withinSessionTimeout(createAuth0Client({
    domain: configuration.auth0.domain,
    clientId: configuration.auth0.clientId,
    cacheLocation: 'memory',
    authorizeTimeoutInSeconds: 12,
    httpTimeoutInSeconds: 10,
    authorizationParams: authorizationParams(),
  }));
  await withinSessionTimeout(handleAuth0Callback());

  const authenticated = await withinSessionTimeout(client.isAuthenticated());
  if (!authenticated) {
    setAccessTokenProvider(null);
    return setState({
      mode: configuration.mode,
      enabled: true,
      authenticated: false,
      user: null,
      error: '',
    });
  }

  setAccessTokenProvider(() => client.getTokenSilently({ authorizationParams: authorizationParams() }));
  const [identity, browserUser] = await withinSessionTimeout(Promise.all([
    api.getCurrentUser(),
    client.getUser(),
  ]));
  if (!identity?.authenticated || !identity.user?.sub) {
    setAccessTokenProvider(null);
    throw new Error('The authenticated identity was not accepted by the application.');
  }

  return setState({
    mode: configuration.mode,
    enabled: true,
    authenticated: true,
    user: mergeDisplayProfile(identity.user, browserUser),
    error: '',
  });
}

export function getAuthenticationState() {
  return authState;
}

export function expireAuthentication(message = '') {
  setAccessTokenProvider(null);
  return setState({
    authenticated: false,
    user: null,
    error: message,
  });
}

export async function signIn() {
  if (!client || !configuration?.enabled) throw new Error('Auth0 is not configured.');
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  await client.loginWithRedirect({
    appState: { returnTo },
    authorizationParams: authorizationParams(),
  });
}

export async function signOut() {
  setAccessTokenProvider(null);
  if (!client || !configuration?.enabled) return;
  await client.logout({
    logoutParams: { returnTo: configuration.auth0.logoutReturnTo },
  });
}
