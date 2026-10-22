import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { pino } from 'pino';
import type { ServerConfig } from './config.js';
import { registerSecurity } from './security.js';
import { ensureToken } from './token.js';
import { VERSION } from './version.js';

export interface HealthResponse {
  ok: true;
  version: string;
}

export interface BuildOptions {
  /** Install token. Defaults to reading (or creating) `<config.home>/token`. */
  token?: string;
}

export async function buildServer(
  config: ServerConfig,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const token = options.token ?? (await ensureToken(config.home));
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

  registerSecurity(app, { config, token });

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, version: VERSION }));

  await app.ready();
  return app;
}

export async function startServer(
  config: ServerConfig,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const app = await buildServer(config, options);
  await app.listen({ port: config.port, host: config.host });
  return app;
}
