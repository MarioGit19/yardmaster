import type { HealthResponse, ServerStatus } from '@c-board/protocol';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { pino } from 'pino';
import { type ActionHandlers, createActionDispatcher, stubActionHandlers } from './actions.js';
import { HookIngest, registerHookRoute } from './claude/hook-ingest.js';
import type { ServerConfig } from './config.js';
import { DemoSimulator } from './demo/simulator.js';
import { Persistence } from './persistence.js';
import { registerSecurity } from './security.js';
import { registerStatic } from './static.js';
import { BoardStore } from './store.js';
import { ensureToken } from './token.js';
import {
  MAX_UI_MESSAGE,
  registerUiGateway,
  UiGateway,
  type UiGatewayOptions,
} from './ui-gateway.js';
import { VERSION } from './version.js';

export type { HealthResponse, ServerStatus };

export interface HookStats {
  received: number;
  lastAt: number | null;
}

export interface BuildOptions {
  /** Install token. Defaults to reading (or creating) `<config.home>/token`. */
  token?: string;
  /** Run the synthetic demo board (F12). Its data never touches `board.db`. */
  demo?: boolean | { seed?: number };
  /** Database file, or `:memory:`. Defaults to `<config.home>/board.db`, or `:memory:` in demo mode. */
  dbPath?: string;
  /** UI action handlers. Defaults to stubs. */
  actions?: ActionHandlers;
  /** Gateway tuning, for tests. */
  gateway?: Pick<UiGatewayOptions, 'patchIntervalMs' | 'maxBufferedBytes'>;
  /** Built web app to serve with an SPA fallback, e.g. `DEFAULT_WEB_ROOT`. Off by default. */
  webRoot?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    store: BoardStore;
    persistence: Persistence;
    /** Settings loaded from the database at boot. */
    settings: Record<string, unknown>;
    demo: DemoSimulator | null;
    /** Updated by the hook ingest; reported by `GET /api/status`. */
    hookStats: HookStats;
    hookIngest: HookIngest;
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
    path: options.dbPath ?? (options.demo ? ':memory:' : undefined),
    logger: logger.child({ component: 'db' }),
  });
  const store = new BoardStore();
  let demo: DemoSimulator | null = null;
  for (const project of persistence.loadProjects()) store.upsertProject(project);
  // Boot state is already on disk; only later changes need writing back.
  store.flush();
  persistence.attach(store);
  app.decorate('store', store);
  app.decorate('persistence', persistence);
  app.decorate('settings', persistence.loadSettings());
  app.addHook('onClose', async () => {
    demo?.stop();
    await hookIngest.idle();
    // Emit any changes made since the last microtask so they reach the database.
    store.flush();
    persistence.close();
  });

  // Before the security layer and any route: it claims upgrade requests, and its onRequest
  // hook must run first so sockets rejected by security are cleaned up.
  await app.register(websocket, { options: { maxPayload: MAX_UI_MESSAGE * 4 } });
  registerSecurity(app, { config, token });

  // Constructed first so the gateway can route approvals to it; it starts once the app is ready.
  demo = options.demo
    ? new DemoSimulator({
        store,
        ...(typeof options.demo === 'object' ? { seed: options.demo.seed } : {}),
        onActivity: (event) => persistence.recordActivity(event),
        onMessage: (message) => gateway.broadcast(message),
      })
    : null;
  const gateway: UiGateway = new UiGateway({
    store,
    dispatch: createActionDispatcher(options.actions ?? stubActionHandlers()),
    ...(demo ? { decideApproval: demo.decideApproval.bind(demo) } : {}),
    logger: logger.child({ component: 'ui-ws' }),
    ...options.gateway,
  });
  app.decorate('uiGateway', gateway);
  registerUiGateway(app, gateway);
  app.decorate('demo', demo);

  const startedAt = Date.now();
  const hookStats: HookStats = { received: 0, lastAt: null };
  app.decorate('hookStats', hookStats);
  const hookIngest = new HookIngest({
    store,
    logger: logger.child({ component: 'hooks' }),
    apply: demo === null,
    onReceived: (ts) => {
      hookStats.received += 1;
      hookStats.lastAt = ts;
    },
    onActivity: (event) => persistence.recordActivity(event),
  });
  app.decorate('hookIngest', hookIngest);
  registerHookRoute(app, hookIngest);

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, version: VERSION }));
  app.get(
    '/api/status',
    async (): Promise<ServerStatus> => ({
      ok: true,
      version: VERSION,
      demo: demo !== null,
      uptimeMs: Date.now() - startedAt,
      editors: Object.keys(store.state.windows).length,
      hooks: { ...app.hookStats },
    }),
  );

  if (options.webRoot !== undefined && !registerStatic(app, options.webRoot)) {
    app.log.debug({ webRoot: options.webRoot }, 'no web build to serve');
  }

  await app.ready();
  demo?.start();
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
