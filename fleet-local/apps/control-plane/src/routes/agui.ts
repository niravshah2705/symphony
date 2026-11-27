import type { FastifyInstance } from 'fastify';
import { a2aFacadeBase } from '@fleet-local/shared';
import { config } from '../config.ts';
import { requireAuth } from '../auth/plugin.ts';
import { assertMember } from '../db/users.ts';
import { assertOrgActive } from '../lifecycle.ts';
import { A2ARequestError, type ErrorInfo } from '../a2a/contract.ts';
import type { FacadeContext } from '../a2a/facade.ts';
import { aguiRun } from '../agui/server.ts';

// The AG-UI run endpoint. One URL, because that is all the protocol's core
// operation needs: a run is POSTed and answered as a stream of events.
//
// Its own Fastify scope, so its error shape stays plain JSON. The A2A scope
// answers in application/a2a+json with an A2AError body, and an AG-UI client
// would read that as an unparseable response and report a transport failure
// instead of the reason.
const BASE = '/api/agui/orgs/:orgId/projects/:projectId/agent';

export async function aguiRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, request, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error(err);
    // A run that already wrote its SSE head is over: the terminal event, not this
    // handler, is what told the client why. Writing here would corrupt the stream.
    if (reply.sent || reply.raw.headersSent) return;
    const info: ErrorInfo | undefined = (err as A2ARequestError).info;
    // `unauthenticated` is thrown by requireAuth as a plain Error, so the status
    // is the only place the reason is recorded — and a client that shows the
    // human "internal_error" for a session that expired is a support ticket.
    const reason = info?.reason ?? (status === 401 ? 'unauthenticated' : 'internal_error');
    reply.code(status).type('application/json').send({
      error: { message: (err as Error).message, code: status, reason },
    });
  });

  app.route({
    method: 'POST',
    url: BASE,
    // The server-wide 4 MB gate would refuse an inline attachment before the
    // turn parser ever sees it; runinput.ts enforces the real per-file 5 MB
    // decoded limit, so this only bounds the whole request envelope.
    bodyLimit: 16 * 1024 * 1024,
    preHandler: async (request, reply) => {
      await requireAuth(request, reply);
      const { orgId } = request.params as { orgId: string };
      await assertMember(orgId, request.fleetUser!.id);
      // Every POST here begins a turn, so the whole endpoint is a new-turn gate. The
      // refusal is a plain 409 rather than a RUN_ERROR because no run ever began —
      // this is the route's own "refuse before the head" rule, applied one layer up.
      await assertOrgActive(orgId);
    },
    handler: async (request, reply) => {
      const { orgId, projectId } = request.params as { orgId: string; projectId: string };
      const bearer = request.cookies[config.sessionCookie];
      if (!bearer) throw new A2ARequestError(401, 'no session token — sign in again');
      const user = request.fleetUser!;
      const ctx: FacadeContext = {
        orgId,
        projectId,
        userId: user.id,
        email: user.email,
        bearer,
        facadeBase: a2aFacadeBase(config.publicOrigin, orgId, projectId),
        log: (message, extra) => request.log.info(extra ?? {}, message),
      };
      await aguiRun(ctx, request, reply, request.body);
      return reply;
    },
  });
}
