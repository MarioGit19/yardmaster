import {
  type ActivityEvent,
  type HealthResponse,
  ProjectId,
  PULSE_WINDOW_MS,
  type ServerStatus,
  type SessionHistoryResponse,
} from '@c-board/protocol';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { pino } from 'pino';
import { z } from 'zod';
import { type ActionHandlers, createActionDispatcher, stubActionHandlers } from './actions.js';
import { AwayApprovals, registerAwayRoutes } from './claude/away.js';
import { HookIngest, registerHookRoute } from './claude/hook-ingest.js';
import { SessionRunner, type SessionRunnerOptions } from './claude/runner.js';
import { SessionDiscovery, type SessionDiscoveryOptions } from './claude/session-discovery.js';
import { TranscriptService, type TranscriptServiceOptions } from './claude/transcript-service.js';
import type { ServerConfig } from './config.js';
import { createDemoQuery } from './demo/demo-query.js';
import { DemoSimulator } from './demo/simulator.js';
import { WorstBoard } from './demo/worst.js';
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
import {
  awaySettings,
  diskHookSettings,
  EDITOR_SEEN_KEY,
  HOOK_SEEN_KEY,
  type HookSettingsFile,
  memoryHookSettings,
  migrateTerminalReply,
  RETENTION_KEY,
  registerSettingsRoutes,
  retentionDays,
  retentionMs,
  rotateTokenFile,
  terminalReplyEnabled,
} from './settings-routes.js';
import { registerStatic } from './static.js';
import { BoardStore } from './store.js';
import { createTerminalReply } from './terminal-reply.js';
import { ensureToken } from './token.js';
import {
  MAX_ACTIVITY_BATCH,
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
  demo?: boolean | { seed?: number; stress?: boolean };
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
  /** Board session runner tuning (tests inject a mocked `query`). Demo mode uses a scripted one. */
  runner?: Pick<SessionRunnerOptions, 'query' | 'newId' | 'draftIntervalMs' | 'approvalTimeoutMs'>;
  /** Session registry discovery tuning, for tests. Not started in demo mode. */
  discovery?: Omit<SessionDiscoveryOptions, 'store' | 'logger'>;
  /** Editor link tuning, for tests. */
  editor?: Pick<EditorGatewayOptions, 'graceMs' | 'idleMs' | 'resolvePath' | 'commandTimeoutMs'>;
  /** Process and port scanner tuning, or false to turn it off. Not started in demo mode. */
  processes?: Omit<ProcessScannerOptions, 'store' | 'logger'> | false;
  /** Git info tuning, or false to turn it off. Not started in demo mode. */
  git?: Omit<GitScannerOptions, 'store' | 'logger' | 'active'> | false;
  /** Claude's settings.json for the hooks routes. Defaults to the real one, or a synthetic one in demo mode. */
  hookSettings?: HookSettingsFile;
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
    awayApprovals: AwayApprovals;
    transcripts: TranscriptService | null;
    sessionRunner: SessionRunner;
    sessionDiscovery: SessionDiscovery | null;
    processScanner: ProcessScanner | null;
    sessionLinker: SessionLinker | null;
    gitScanner: GitScanner | null;
  }
}

const ProjectParams = z.object({ projectId: ProjectId });

export async function buildServer(
  config: ServerConfig,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  // Mutable: Settings can rotate it while the server runs.
  let token = options.token ?? (await ensureToken(config.home));
  const currentToken = () => token;
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
  const settings = persistence.loadSettings();
  migrateTerminalReply(settings, (key, value) => persistence.setSetting(key, value));
  app.decorate('settings', settings);
  if (settings[RETENTION_KEY] !== undefined) {
    persistence.setRetention(retentionMs(retentionDays(settings[RETENTION_KEY])));
  }
  // First-run detection survives restarts, so the onboarding never reappears once set up.
  const seen = (key: string) => settings[key] === true;
  const markSeen = (key: string) => {
    if (seen(key)) return;
    settings[key] = true;
    persistence.setSetting(key, true);
  };
  app.addHook('onClose', async () => {
    demo?.stop();
    worst?.stop();
    processScanner?.stop();
    sessionLinker?.stop();
    gitScanner?.stop();
    await runner.closeAll();
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
  registerSecurity(app, { config, token: currentToken });

  // Stored for history and pushed live to the Pulse rail. Nothing emits before the app is ready.
  const recordActivity = (event: ActivityEvent) => {
    persistence.recordActivity(event);
    gateway.pushActivity(event);
  };

  // Constructed first so the gateway can route approvals to it; it starts once the app is ready.
  demo = options.demo
    ? new DemoSimulator({
        store,
        ...(typeof options.demo === 'object'
          ? { seed: options.demo.seed, stress: options.demo.stress }
          : {}),
        onActivity: recordActivity,
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
  // Demo board sessions run the real runner over a scripted query and the demo transcripts.
  const demoTranscripts = demo?.transcripts;
  const runner = new SessionRunner({
    store,
    transcripts: demoTranscripts ?? transcripts,
    logger: logger.child({ component: 'runner' }),
    onActivity: recordActivity,
    onMessage: (message) => gateway.broadcast(message),
    ...(demoTranscripts
      ? { query: createDemoQuery({ onFork: (from, to) => demoTranscripts.copy(from, to) }) }
      : {}),
    ...options.runner,
  });
  app.decorate('sessionRunner', runner);
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
    onActivity: recordActivity,
    ...options.editor,
  });
  app.decorate('editorGateway', editorGateway);
  registerEditorGateway(app, editorGateway, currentToken);
  const editorRouter = new EditorRouter({
    state: () => store.state,
    isConnected: (windowId) => editorGateway.isConnected(windowId),
  });
  const actions = options.actions ?? defaultActions();
  function defaultActions(): ActionHandlers {
    const handlers: ActionHandlers = {
      ...stubActionHandlers(),
      ...createEditorActions({
        router: editorRouter,
        send: editorGateway.sendCommand.bind(editorGateway),
      }),
      ...runner.actions(),
      // Demo windows have no socket, so the simulator plays the editor's part.
      ...demo?.terminalActions(),
    };
    return {
      ...handlers,
      ...createTerminalReply({
        state: () => store.state,
        enabled: () => terminalReplyEnabled(settings),
        sendText: handlers['terminal.sendText'],
      }),
    };
  }

  const gateway: UiGateway = new UiGateway({
    store,
    ...(transcripts ? { transcripts } : demo ? { transcripts: demo.transcripts } : {}),
    dispatch: createActionDispatcher(actions),
    // Board sessions, then away-mode hooks; demo approvals come from the simulator.
    decideApproval: (decision) => {
      let result = runner.decideApproval(decision);
      if (!result.ok) result = awayApprovals.decide(decision);
      return demo && !result.ok ? demo.decideApproval(decision) : result;
    },
    sendToSession: runner.send.bind(runner),
    recentActivity: () =>
      persistence.listActivity({ since: Date.now() - PULSE_WINDOW_MS, limit: MAX_ACTIVITY_BATCH }),
    logger: logger.child({ component: 'ui-ws' }),
    ...options.gateway,
  });
  app.decorate('uiGateway', gateway);
  // `?worst=1`: a static board of worst-case data for layout checks, demo mode only.
  const worst = options.demo ? new WorstBoard() : null;
  const worstGateway = worst
    ? new UiGateway({
        store: worst.store,
        dispatch: createActionDispatcher(stubActionHandlers()),
        recentActivity: () => worst.recentActivity(),
        logger: logger.child({ component: 'ui-ws-worst' }),
      })
    : undefined;
  registerUiGateway(app, gateway, worstGateway);
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
      markSeen(HOOK_SEEN_KEY);
    },
    onActivity: recordActivity,
    onToolDone: (tool, projectId) => {
      if (projectId !== null && GIT_TOUCHING_TOOLS.has(tool)) gitScanner?.request(projectId);
    },
  });
  app.decorate('hookIngest', hookIngest);
  registerHookRoute(app, hookIngest);
  const awayApprovals: AwayApprovals = new AwayApprovals({
    store,
    ingest: hookIngest,
    logger: logger.child({ component: 'away' }),
    status: () => {
      const { awayMode, awayTimeoutSec } = awaySettings(settings);
      return { away: awayMode, timeoutSec: awayTimeoutSec };
    },
    apply: demo === null,
    onMessage: (message) => gateway.broadcast(message),
    onActivity: recordActivity,
  });
  app.decorate('awayApprovals', awayApprovals);
  registerAwayRoutes(app, awayApprovals);

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, version: VERSION }));
  app.get('/api/status', async (): Promise<ServerStatus> => {
    const editors = Object.keys(store.state.windows).length;
    if (editors > 0) markSeen(EDITOR_SEEN_KEY);
    return {
      ok: true,
      version: VERSION,
      demo: demo !== null,
      uptimeMs: Date.now() - startedAt,
      editors,
      hooks: { ...app.hookStats },
      setup: { hookSeen: seen(HOOK_SEEN_KEY), editorSeen: seen(EDITOR_SEEN_KEY) },
    };
  });
  registerSettingsRoutes(app, {
    persistence,
    settings,
    hookSettings:
      options.hookSettings ?? (options.demo ? memoryHookSettings() : diskHookSettings()),
    // The demo board may run on a real home: never touch its token.
    rotateToken: options.demo
      ? null
      : async () => {
          token = await rotateTokenFile(config.home);
          return token;
        },
  });

  app.get('/api/projects/:projectId/sessions', async (request, reply) => {
    const params = ProjectParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request' });
    const { projectId } = params.data;
    const worstHistory = worst?.sessionHistory(projectId);
    if (worstHistory) return { sessions: worstHistory } satisfies SessionHistoryResponse;
    if (!store.state.projects[projectId]) return reply.code(404).send({ error: 'unknown_project' });
    const listed = demo
      ? demo.sessionHistory(projectId)
      : ((await discovery?.freshHistory(projectId)) ?? []);
    // The SDK listing carries no usage: fill it in for sessions the board has seen live.
    const stored = demo ? new Map() : persistence.sessionTokens(projectId);
    const sessions = listed.map((entry) => ({
      ...entry,
      tokens:
        entry.tokens ?? store.state.sessions[entry.id]?.tokens ?? stored.get(entry.id) ?? null,
    }));
    return { sessions } satisfies SessionHistoryResponse;
  });

  if (options.webRoot !== undefined && !registerStatic(app, options.webRoot)) {
    app.log.debug({ webRoot: options.webRoot }, 'no web build to serve');
  }

  await app.ready();
  demo?.start();
  worst?.start(() => (worstGateway?.clientCount ?? 0) > 0);
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
