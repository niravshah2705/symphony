'use strict';

const crypto = require('node:crypto');
const express = require('express');
const log = require('@ai-fleet/shared-core/logger');
const { createRepositoryFromEnv } = require('./repository');
const { createDigiLockerProvider } = require('./provider');
const {
  normalizeChecks,
  claimId,
  normalizeProviderResult,
  publicResult,
} = require('./identity');

function cleanId(value) {
  const text = String(value || '').trim();
  return text && text.length <= 160 ? text : '';
}

function requestContext(req) {
  return {
    organizationId: cleanId(req.get('x-ai-fleet-organization-id')),
    projectId: cleanId(req.get('x-ai-fleet-project-id')),
    userId: cleanId(req.get('x-ai-fleet-user-id')) || cleanId(req.get('x-forwarded-user-id')) || 'local-user',
  };
}

function safeSession(session) {
  if (!session) return null;
  const { oauthStateHash, tokenRef, ...rest } = session;
  return rest;
}

function createIdentityService(options = {}) {
  const now = options.now || Date.now;
  const production = process.env.NODE_ENV === 'production';
  const pepper = options.hashPepper || process.env.IDENTITY_HASH_PEPPER || (production ? '' : 'local-development-identity-pepper');
  if (!pepper) {
    throw Object.assign(new Error('IDENTITY_HASH_PEPPER is required in production.'), {
      status: 500,
      code: 'identity_hash_pepper_required',
    });
  }
  const repository = options.repository || createRepositoryFromEnv(process.env);
  const provider = options.provider || createDigiLockerProvider({
    mock: String(process.env.IDENTITY_PROVIDER || 'mock').toLowerCase() === 'mock',
    env: process.env,
  });

  async function createSession(ctx, requestedChecks) {
    const sessionId = crypto.randomUUID();
    const stateSecret = crypto.randomBytes(24).toString('base64url');
    const oauthStateHash = crypto.createHash('sha256').update(stateSecret).digest('base64url');
    const auth = await provider.createAuthorization({ sessionId, requestedChecks, state: stateSecret, context: ctx });
    const session = {
      sessionId,
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      userId: ctx.userId,
      requestedChecks,
      status: 'consent_pending',
      provider: auth.provider || 'digilocker',
      oauthStateHash,
      tokenRef: null,
      resultId: null,
      errorCode: null,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      expiresAt: auth.tokenExpiresAt || null,
      revokedAt: null,
    };
    await repository.transact((state) => { state.sessions[sessionId] = session; });
    return { session: safeSession(session), authorizeUrl: auth.authorizeUrl };
  }

  async function getOwnedSession(sessionId, ctx) {
    const session = await repository.getSession(sessionId);
    if (!session || session.userId !== ctx.userId || session.organizationId !== ctx.organizationId) return null;
    return session;
  }

  async function processSession(session, code = '') {
    const raw = await provider.fetchVerifiedFacts({ session, code, requestedChecks: session.requestedChecks });
    const normalized = normalizeProviderResult(raw, { pepper, now });
    const resultId = crypto.randomUUID();
    const timestamp = new Date(now()).toISOString();
    return repository.transact((state) => {
      const current = state.sessions[session.sessionId];
      if (!current || current.status === 'revoked') {
        throw Object.assign(new Error('Verification session is no longer active.'), { status: 409, code: 'session_closed' });
      }
      for (const claim of normalized.claims) {
        const id = claimId(claim.claimType, claim.claimHash);
        const existing = state.claims[id];
        if (existing && existing.status === 'active' && existing.ownerUserId !== session.userId) {
          current.status = 'failed';
          current.errorCode = 'identity_claim_conflict';
          current.updatedAt = timestamp;
          throw Object.assign(new Error(`${claim.claimType.toUpperCase()} is already registered with another user.`), {
            status: 409,
            code: 'identity_claim_conflict',
            claimType: claim.claimType,
          });
        }
      }
      const storedResult = {
        resultId,
        sessionId: session.sessionId,
        organizationId: session.organizationId,
        projectId: session.projectId,
        userId: session.userId,
        ...normalized,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.results[resultId] = storedResult;
      for (const claim of normalized.claims) {
        const id = claimId(claim.claimType, claim.claimHash);
        state.claims[id] = {
          claimType: claim.claimType,
          claimHash: claim.claimHash,
          ownerUserId: session.userId,
          organizationId: session.organizationId,
          resultId,
          sourceSessionId: session.sessionId,
          status: 'active',
          createdAt: state.claims[id]?.createdAt || timestamp,
          updatedAt: timestamp,
          releasedAt: null,
        };
      }
      current.status = 'verified';
      current.resultId = resultId;
      current.errorCode = null;
      current.updatedAt = timestamp;
      return { session: safeSession(current), result: publicResult(storedResult) };
    });
  }

  function validateOauthState(session, stateSecret) {
    const given = crypto.createHash('sha256').update(String(stateSecret || '')).digest('base64url');
    const left = Buffer.from(given);
    const right = Buffer.from(session.oauthStateHash || '');
    if (!session.oauthStateHash || left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw Object.assign(new Error('OAuth state is invalid.'), { status: 400, code: 'invalid_oauth_state' });
    }
  }

  async function revokeSession(session, ctx) {
    const timestamp = new Date(now()).toISOString();
    await provider.revoke({ session });
    return repository.transact((state) => {
      const current = state.sessions[session.sessionId];
      if (!current || current.userId !== ctx.userId) return null;
      current.status = 'revoked';
      current.revokedAt = timestamp;
      current.updatedAt = timestamp;
      for (const claim of Object.values(state.claims)) {
        if (claim.ownerUserId === ctx.userId && claim.sourceSessionId === session.sessionId && claim.status === 'active') {
          claim.status = 'released';
          claim.releasedAt = timestamp;
          claim.updatedAt = timestamp;
        }
      }
      return safeSession(current);
    });
  }

  return { createSession, getOwnedSession, processSession, revokeSession, validateOauthState, repository };
}

function createApp(options = {}) {
  const logger = options.logger || log;
  const service = options.service || createIdentityService(options);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.get('/healthz', (req, res) => res.json({ status: 'ok', service: 'identity-verification' }));
  app.get('/readyz', (req, res) => res.json({ status: 'ready', service: 'identity-verification' }));

  app.post('/sessions', async (req, res, next) => {
    try {
      const ctx = requestContext(req);
      if (!ctx.organizationId) return res.status(400).json({ error: 'Organization context is required.', code: 'organization_required' });
      const requestedChecks = normalizeChecks(req.body && req.body.checks);
      const out = await service.createSession(ctx, requestedChecks);
      return res.status(201).json(out);
    } catch (err) { return next(err); }
  });

  app.get('/sessions/:id', async (req, res, next) => {
    try {
      const session = await service.getOwnedSession(req.params.id, requestContext(req));
      if (!session) return res.status(404).json({ error: 'Verification session not found.', code: 'not_found' });
      return res.json({ session: safeSession(session) });
    } catch (err) { return next(err); }
  });

  app.get('/sessions/:id/result', async (req, res, next) => {
    try {
      const session = await service.getOwnedSession(req.params.id, requestContext(req));
      if (!session) return res.status(404).json({ error: 'Verification session not found.', code: 'not_found' });
      if (!session.resultId) return res.status(202).json({ session: safeSession(session), result: null });
      const result = await service.repository.getResult(session.resultId);
      return res.json({ session: safeSession(session), result: publicResult(result) });
    } catch (err) { return next(err); }
  });

  app.post('/sessions/:id/mock-complete', async (req, res, next) => {
    try {
      const session = await service.getOwnedSession(req.params.id, requestContext(req));
      if (!session) return res.status(404).json({ error: 'Verification session not found.', code: 'not_found' });
      const out = await service.processSession(session, 'mock');
      return res.json(out);
    } catch (err) { return next(err); }
  });

  app.post('/sessions/:id/revoke', async (req, res, next) => {
    try {
      const ctx = requestContext(req);
      const session = await service.getOwnedSession(req.params.id, ctx);
      if (!session) return res.status(404).json({ error: 'Verification session not found.', code: 'not_found' });
      const revoked = await service.revokeSession(session, ctx);
      return res.json({ session: revoked });
    } catch (err) { return next(err); }
  });

  app.get('/oauth/callback', async (req, res, next) => {
    try {
      const sessionId = cleanId(req.query.sessionId);
      const session = await service.repository.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Verification session not found.', code: 'not_found' });
      service.validateOauthState(session, req.query.state);
      const out = await service.processSession(session, cleanId(req.query.code));
      return res.json(out);
    } catch (err) { return next(err); }
  });

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = Number(err && err.status) || 500;
    if (status >= 500) logger.error(`identity verification failed: ${err && err.message ? err.message : err}`);
    return res.status(status).json({ error: err.message || 'Identity verification failed.', code: err.code || 'identity_error', claimType: err.claimType });
  });
  return app;
}

module.exports = { createApp, createIdentityService, requestContext };
