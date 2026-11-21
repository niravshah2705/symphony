import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { verifyGoogleIdToken } from './google.ts';
import { mintSession, readSession } from './session.ts';
import { upsertUser, getUser, type UserRow } from '../db/users.ts';

declare module 'fastify' {
  interface FastifyRequest {
    fleetUser: UserRow | null;
  }
}

// Resolve the caller from the edge contract: oauth2-proxy forwards the Google ID
// token as `Authorization: Bearer` (verified here with JWKS). The SPA may instead
// present the fleet_sess cookie minted on first verified login. Client-supplied
// x-auth-request-* / x-fleet-* headers are NEVER trusted (nginx strips them too).
async function resolveIdentity(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  request.fleetUser = null;
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const identity = await verifyGoogleIdToken(auth.slice(7));
      const user = await upsertUser(identity);
      request.fleetUser = user;
      const token = await mintSession({ uid: user.id, email: user.email });
      reply.setCookie(config.sessionCookie, token, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: config.sessionTtlSeconds,
      });
      return;
    } catch {
      // fall through to cookie / unauthenticated
    }
  }
  const cookieToken = request.cookies[config.sessionCookie];
  if (cookieToken) {
    const claims = await readSession(cookieToken);
    if (claims) {
      const user = await getUser(claims.uid);
      if (user) request.fleetUser = user;
    }
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await resolveIdentity(request, reply);
  if (!request.fleetUser) {
    reply.code(401).send({ error: 'unauthenticated' });
  }
}

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(cookie);
  fastify.decorateRequest('fleetUser', null);
}

export default fp(authPlugin, { name: 'fleet-auth' });