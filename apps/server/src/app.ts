import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { pino } from 'pino';
import { type ActionHandlers, createActionDispatcher, stubActionHandlers } from './actions.js';
import type { ServerConfig } from './config.js';
import { Persistence } from './persistence.js';
import { registerSecurity } from './security.js';
import { BoardStore } from './store.js';
import { ensureToken } from './token.js';
import {
  MAX_UI_MESSAGE,
  registerUiGateway,
  UiGateway,
  type UiGatewayOptions,
} from './ui-gateway.js';
import { VERSION } from './version.js';

export interface HealthResponse {
  ok: true;
  version: string;
}

export interface BuildOptions {
  /** Install token. Defaults to reading (or creating) `<config.home>/token`. */
  token?: string;
  /** Database file, or `:memory:`. Defaults to `<config.home>/board.db`. */
  dbPath?: string;
  /** UI action handlers. Defaults to stubs. */
  actions?: ActionHandlers;
  /** Gateway tuning, for tests. */
  gateway?: Pick<UiGatewayOptions, 'patchIntervalMs' | 'maxBufferedBytes'>;
}

declare module 'fastify' {
  interface FastifyInstance {
    store: BoardStore;
    persistence: Persistence;
    /** Settings loaded from the database at boot. */
    settings: Record<string, unknown>;
  }
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

  const persistence = new Persistence({
    home: config.home,
    path: options.dbPath,
    logger: logger.child({ component: 'db' }),
  });
  const store = new BoardStore();
  for (const project of persistence.loadProjects()) store.upsertProject(project);
  // Boot state is already on disk; only later changes need writing back.
  store.flush();
  persistence.attach(store);
  app.decorate('store', store);
  app.decorate('persistence', persistence);
  app.decorate('settings', persistence.loadSettings());
  app.addHook('onClose', async () => {
    // Emit any changes made since the last microtask so they reach the database.
    store.flush();
    persistence.close();
  });

  // Before the security layer and any route: it claims upgrade requests, and its onRequest
  // hook must run first so sockets rejected by security are cleaned up.
  await app.register(websocket, { options: { maxPayload: MAX_UI_MESSAGE * 4 } });
  registerSecurity(app, { config, token });

  const gateway = new UiGateway({
    store,
    dispatch: createActionDispatcher(options.actions ?? stubActionHandlers()),
    logger: logger.child({ component: 'ui-ws' }),
    ...options.gateway,
  });
  app.decorate('uiGateway', gateway);
  registerUiGateway(app, gateway);

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
