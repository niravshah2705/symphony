import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import authPlugin from './auth/plugin.ts';
import { authRoutes } from './routes/auth.ts';
import { orgRoutes } from './routes/orgs.ts';
import { chatRoutes } from './routes/chat.ts';
import { a2aRoutes } from './routes/a2a.ts';
import { aguiRoutes } from './routes/agui.ts';
import { migrate, close } from './db/client.ts';
import { startSweeper } from './metering/sweeper.ts';
import { startQoderTokenLoop } from './credentials/qoderTokens.ts';
import { shutdownMetrics } from './metering/otlp.ts';

async function build() {
  const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });

  app.setErrorHandler((err, request, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error(err);
    if (reply.sent || reply.raw.headersSent) return;
    reply.code(status).send({ error: (err as Error).message });
  });

  await app.register(authPlugin);
  app.get('/healthz', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(chatRoutes);
  // Registered as a child scope on purpose: the `application/a2a+json` parser and
  // the A2A-shaped error handler belong to the facade routes only, and must not
  // change how every other endpoint reports an error. Both stay before
  // fastifyStatic, whose SPA fallback would otherwise answer a mis-typed A2A call
  // with index.html.
  await app.register(a2aRoutes);
  // The AG-UI leg speaks to the same conversations as the facade above; it is a
  // separate scope because its error body is plain JSON, not an A2AError.
  await app.register(aguiRoutes);

  if (config.spaRoot) {
    await app.register(fastifyStatic, { root: config.spaRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

async function main() {
  await migrate();
  const app = await build();
  const sweeper = startSweeper();
  const qoderTokens = startQoderTokenLoop();
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async () => {
    clearInterval(sweeper);
    clearInterval(qoderTokens);
    await app.close();
    await shutdownMetrics().catch(() => undefined);
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});