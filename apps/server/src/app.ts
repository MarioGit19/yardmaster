import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { pino } from 'pino';
import type { ServerConfig } from './config.js';
import { VERSION } from './version.js';

export interface HealthResponse {
  ok: true;
  version: string;
}

export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const logger: FastifyBaseLogger = pino({
    name: 'c-board',
    level: config.logLevel,
    // Omit the default hostname so logs carry nothing machine-specific.
    base: { pid: process.pid },
  });
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, version: VERSION }));

  await app.ready();
  return app;
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = await buildServer(config);
  await app.listen({ port: config.port, host: config.host });
  return app;
}
