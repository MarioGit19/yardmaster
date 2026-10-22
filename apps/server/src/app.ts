import type { HealthResponse, ServerStatus } from '@c-board/protocol';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { pino } from 'pino';
import { type ActionHandlers, createActionDispatcher, stubActionHandlers } from './actions.js';
import { HookIngest, registerHookRoute } from './claude/hook-ingest.js';
import { SessionDiscovery, type SessionDiscoveryOptions } from './claude/session-discovery.js';
import { TranscriptService, type TranscriptServiceOptions } from './claude/transcript-service.js';
import type { ServerConfig } from './config.js';
import { DemoSimulator } from './demo/simulator.js';
import { createEditorActions } from './editor-actions.js';
import {
  EditorGateway,
  type EditorGatewayOptions,
  registerEditorGateway,
} from './editor-gateway.js';
import { EditorRouter } from './editor-router.js';
import { GitScanner, type GitScannerOptions } from './git-scanner.js';
import { Persistence } from './persistence.js';
import { ProcessScanner, type ProcessScannerOptions } from './process-scanner.js';
import { registerSecurity } from './security.js';
import { SessionLinker } from './session-linker.js';
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
  /** UI action handlers. Defaults to the editor bridge for terminal actions and stubs for the rest. */
  actions?: ActionHandlers;
  /** Gateway tuning, for tests. */
  gateway?: Pick<UiGatewayOptions, 'patchIntervalMs' | 'maxBufferedBytes'>;
  /** Built web app to serve with an SPA fallback, e.g. `DEFAULT_WEB_ROOT`. Off by default. */
  webRoot?: string;
  /** Transcript reader tuning, for tests. Not started in demo mode. */
  transcripts?: Pick<TranscriptServiceOptions, 'loadHistory' | 'watchFile' | 'claudeConfigDir'>;
  /** Session registry discovery tuning, for tests. Not started in demo mode. */
  discovery?: Omit<SessionDiscoveryOptions, 'store' | 'logger'>;
  /** Editor link tuning, for tests. */
  editor?: Pick<EditorGatewayOptions, 'graceMs' | 'idleMs' | 'resolvePath' | 'commandTimeoutMs'>;
  /** Process and port scanner tuning, or false to turn it off. Not started in demo mode. */
  processes?: Omit<ProcessScannerOptions, 'store' | 'logger'> | false;
  /** Git info tuning, or false to turn it off. Not started in demo mode. */
  git?: Omit<GitScannerOptions, 'store' | 'logger' | 'active'> | false;
}

/** Tools whose completion can change a repository's state. */
const GIT_TOUCHING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);

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
    transcripts: TranscriptService | null;
    sessionDiscovery: SessionDiscovery | null;
    processScanner: ProcessScanner | null;
    sessionLinker: SessionLinker | null;
    gitScanner: GitScanner | null;
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
    processScanner?.stop();
    sessionLinker?.stop();
    gitScanner?.stop();
    await discovery?.stop();
    await editorGateway.idle();
    await hookIngest.idle();
    await transcripts?.close();
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
  const transcripts = options.demo
    ? null
    : new TranscriptService({
        store,
        logger: logger.child({ component: 'transcripts' }),
        ...options.transcripts,
      });
  app.decorate('transcripts', transcripts);
  const discovery = options.demo
    ? null
    : new SessionDiscovery({
        store,
        logger: logger.child({ component: 'discovery' }),
        ...options.discovery,
      });
  app.decorate('sessionDiscovery', discovery);
  const processOptions = options.demo ? false : (options.processes ?? {});
  const processScanner =
    processOptions === false
      ? null
      : new ProcessScanner({
          store,
          logger: logger.child({ component: 'processes' }),
          ...processOptions,
          onSample: (tree) => {
            processOptions.onSample?.(tree);
            sessionLinker?.link();
          },
        });
  const sessionLinker = processScanner
    ? new SessionLinker({ store, tree: () => processScanner.tree })
    : null;
  app.decorate('processScanner', processScanner);
  app.decorate('sessionLinker', sessionLinker);
  const editorGateway = new EditorGateway({
    store,
    logger: logger.child({ component: 'editor-ws' }),
    apply: demo === null,
    onActivity: (event) => persistence.recordActivity(event),
    ...options.editor,
  });
  app.decorate('editorGateway', editorGateway);
  registerEditorGateway(app, editorGateway, token);
  const editorRouter = new EditorRouter({
    state: () => store.state,
    isConnected: (windowId) => editorGateway.isConnected(windowId),
  });
  const actions = options.actions ?? {
    ...stubActionHandlers(),
    ...createEditorActions({
      router: editorRouter,
      send: editorGateway.sendCommand.bind(editorGateway),
    }),
    // Demo windows have no socket, so the simulator plays the editor's part.
    ...demo?.terminalActions(),
  };

  const gateway: UiGateway = new UiGateway({
    store,
    ...(transcripts ? { transcripts } : demo ? { transcripts: demo.transcripts } : {}),
    dispatch: createActionDispatcher(actions),
    ...(demo ? { decideApproval: demo.decideApproval.bind(demo) } : {}),
    logger: logger.child({ component: 'ui-ws' }),
    ...options.gateway,
  });
  app.decorate('uiGateway', gateway);
  registerUiGateway(app, gateway);
  const gitOptions = options.demo ? false : (options.git ?? {});
  const gitScanner =
    gitOptions === false
      ? null
      : new GitScanner({
          store,
          logger: logger.child({ component: 'git' }),
          active: () => gateway.clientCount > 0,
          ...gitOptions,
        });
  app.decorate('gitScanner', gitScanner);
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
    onToolDone: (tool, projectId) => {
      if (projectId !== null && GIT_TOUCHING_TOOLS.has(tool)) gitScanner?.request(projectId);
    },
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
  discovery?.start();
  sessionLinker?.start();
  processScanner?.start();
  gitScanner?.start();
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
