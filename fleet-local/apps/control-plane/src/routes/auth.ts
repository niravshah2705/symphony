import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.ts';
import { orgsForUser } from '../db/users.ts';
import { config } from '../config.ts';

function publicUser(user: { id: string; email: string; name: string | null }) {
  return { id: user.id, email: user.email, name: user.name };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // The SPA presents the Google ID token as Bearer; requireAuth verifies it (JWKS)
  // and mints the fleet_sess cookie. Subsequent calls use the cookie.
  app.post('/api/auth/login', { preHandler: requireAuth }, async (request) => {
    const user = request.fleetUser!;
    return { user: publicUser(user), orgs: await orgsForUser(user.id) };
  });

  app.get('/api/me', { preHandler: requireAuth }, async (request) => {
    const user = request.fleetUser!;
    return { user: publicUser(user), orgs: await orgsForUser(user.id) };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(config.sessionCookie, { path: '/' });
    return { ok: true };
  });
}