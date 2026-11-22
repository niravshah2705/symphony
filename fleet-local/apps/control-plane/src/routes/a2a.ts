import type { FastifyInstance, FastifyReply } from 'fastify';
import { A2A_CONTENT_TYPE, MODEL_HEADER, a2aFacadeBase } from '@fleet-local/shared';
import { config } from '../config.ts';
import { requireAuth } from '../auth/plugin.ts';
import { assertMember } from '../db/users.ts';
import { A2ARequestError, toA2AErrorBody, truncate, type ErrorInfo } from '../a2a/contract.ts';
import { routeFacadePath } from '../a2a/translate.ts';
import {
  facadeAgentCard,
  facadeCancel,
  facadeGetTask,
  facadeSend,
  facadeStream,
  facadeSubscribe,
  type FacadeContext,
} from '../a2a/facade.ts';
import type { RpcResult } from '../kagent/a2a.ts';

// Mounted as ONE wildcard per project, because the A2A REST binding spells its
// methods `message:stream` and `tasks/{id}:cancel` — colons inside a segment,
// which find-my-way cannot express as a :param pattern. routeFacadePath decides
// the call, so the shape of the URL space is a pure function and a test.
const BASE = '/api/a2a/orgs/:orgId/projects/:projectId';

// A non-2xx from the controller must still reach the client as an A2AError, or
// the reason is dropped somewhere between this service and the browser.
function upstreamMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
    if (typeof error === 'string' && error) return error;
  }
  return JSON.stringify(body ?? {}).slice(0, 400);
}

function sendRpc(reply: FastifyReply, rpc: RpcResult): FastifyReply {
  if (rpc.status >= 400) {
    const info: ErrorInfo = { reason: 'upstream_rejected' };
    return reply
      .code(rpc.status)
      .type(A2A_CONTENT_TYPE)
      .send(JSON.stringify(toA2AErrorBody(rpc.status, truncate(upstreamMessage(rpc.body)), info)));
  }
  // A JSON-RPC error carried inside a 200 is the controller's own A2A-level
  // verdict, and the client understands it — forward it, do not launder it.
  return reply.code(rpc.status).type(A2A_CONTENT_TYPE).send(JSON.stringify(rpc.body));
}

function requireMethod(request: { method?: string }, method: string): void {
  if (request.method !== method) {
    throw new A2ARequestError(405, `${method} is required for this A2A method`, { reason: 'wrong_method' });
  }
}

export async function a2aRoutes(app: FastifyInstance): Promise<void> {
  // The A2A REST bindings post their own media type; without this Fastify answers 415.
  app.addContentTypeParser(A2A_CONTENT_TYPE, { parseAs: 'string' }, (_request, body, done) => {
    const text = String(body);
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(new A2ARequestError(400, 'request body is not valid JSON'), undefined);
    }
  });

  // Everything in this scope answers in the A2A error shape: the client builds
  // A2AError{code,status,message,details} from exactly this, and nothing else
  // carries a reason to the UI.
  app.setErrorHandler((err, request, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error(err);
    if (reply.sent || reply.raw.headersSent) return;
    const info = (err as A2ARequestError).info;
    reply
      .code(status)
      .type(A2A_CONTENT_TYPE)
      .send(JSON.stringify(toA2AErrorBody(status, (err as Error).message, info)));
  });

  app.route({
    method: ['GET', 'POST'],
    url: `${BASE}/*`,
    preHandler: async (request, reply) => {
      await requireAuth(request, reply);
      const { orgId } = request.params as { orgId: string };
      await assertMember(orgId, request.fleetUser!.id);
    },
    handler: async (request, reply) => {
      const { orgId, projectId } = request.params as { orgId: string; projectId: string };
      const tail = (request.params as { '*': string })['*'] ?? '';
      const call = routeFacadePath(tail);
      // The controller authenticates the BFF's own minted token (the edge hands
      // the browser an ID token, which kagent would not accept); the browser's
      // Authorization header is deliberately never forwarded.
      const bearer = request.cookies[config.sessionCookie];
      if (!bearer) throw new A2ARequestError(401, 'no session token — sign in again');
      const user = request.fleetUser!;
      const hint = request.headers[MODEL_HEADER];
      const ctx: FacadeContext = {
        orgId,
        projectId,
        userId: user.id,
        email: user.email,
        bearer,
        facadeBase: a2aFacadeBase(config.publicOrigin, orgId, projectId),
        modelHint: typeof hint === 'string' && hint ? hint : undefined,
        log: (message, extra) => request.log.info(extra ?? {}, message),
      };

      switch (call.kind) {
        case 'agent-card':
          return reply.type('application/json').send(await facadeAgentCard(ctx));

        case 'stream': {
          requireMethod(request, 'POST');
          await facadeStream(ctx, request, reply, request.body);
          return reply;
        }

        case 'send': {
          requireMethod(request, 'POST');
          return sendRpc(reply, await facadeSend(ctx, request.body));
        }

        case 'task': {
          if (!call.taskId) throw new A2ARequestError(400, 'a task id is required');
          switch (call.action) {
            case 'get':
              requireMethod(request, 'GET');
              return sendRpc(reply, await facadeGetTask(ctx, call.taskId));
            case 'cancel':
              requireMethod(request, 'POST');
              return sendRpc(reply, await facadeCancel(ctx, call.taskId));
            case 'subscribe':
              requireMethod(request, 'POST');
              await facadeSubscribe(ctx, call.taskId, reply);
              return reply;
            default:
              throw new A2ARequestError(501, `this agent does not support "${call.action}" on a task`, {
                reason: 'unimplemented',
              });
          }
        }

        case 'extended-card':
          throw new A2ARequestError(501, 'this agent publishes only the standard card at .well-known/agent-card.json', {
            reason: 'extended_card_unsupported',
          });

        default:
          throw new A2ARequestError(404, `unknown A2A path "${call.path}"`, { reason: 'unknown_path' });
      }
    },
  });
}
