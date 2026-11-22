import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import authPlugin from './auth/plugin.ts';
import { authRoutes } from './routes/auth.ts';
import { orgRoutes } from './routes/orgs.ts';
import { chatRoutes } from './routes/chat.ts';
import { migrate, close } from './db/client.ts';
import { startSweeper } from './metering/sweeper.ts';
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
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async () => {
    clearInterval(sweeper);
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