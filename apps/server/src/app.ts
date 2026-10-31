import { createHash } from 'node:crypto';
import { join } from 'node:path';
import websocket from '@fastify/websocket';
import {
  AccountUsage,
  type ActivityEvent,
  type ApprovalDecision,
  type DashboardLinkResponse,
  type HealthResponse,
  HISTORY_WINDOW_MS,
  type LibraryResponse,
  LOCAL_ROUTES,
  type Project,
  ProjectId,
  type ServerStatus,
  type SessionHistoryResponse,
  UI_WS_PROTOCOL,
  WS_UNAUTHORIZED,
} from '@yardmaster/protocol';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { pino } from 'pino';
import { z } from 'zod';
import { type ActionHandlers, createActionDispatcher, stubActionHandlers } from './actions.js';
import { AwayApprovals, registerAwayRoutes } from './claude/away.js';
import { BackgroundTracker } from './claude/background-tracker.js';
import { FolderTrust, TRUSTED_FOLDERS_KEY } from './claude/folder-trust.js';
import { HookIngest, registerHookRoute } from './claude/hook-ingest.js';
import { SessionRunner, type SessionRunnerOptions } from './claude/runner.js';
import { SessionDiscovery, type SessionDiscoveryOptions } from './claude/session-discovery.js';
import { registerStatuslineRoute } from './claude/statusline-ingest.js';
import { TranscriptService, type TranscriptServiceOptions } from './claude/transcript-service.js';
import type { ServerConfig } from './config.js';
import { secureDataDir } from './data-dir.js';
import { createDemoQuery } from './demo/demo-query.js';
import {
  DEMO_LIBRARY_ROOT,
  demoFolderHasGit,
  demoLibrary,
  readDemoTrustFile,
} from './demo/library.js';
import { demoPty } from './demo/pty.js';
import { runPushDrill } from './demo/push-drill.js';
import { DemoSimulator } from './demo/simulator.js';
import { demoTailscale } from './demo/tailscale.js';
import { WorstBoard } from './demo/worst.js';
import { closeProjectWindows, createEditorActions } from './editor-actions.js';
import { EditorLauncher, type EditorLauncherOptions } from './editor-cli.js';
import {
  EditorGateway,
  type EditorGatewayOptions,
  registerEditorGateway,
} from './editor-gateway.js';
import { EditorRouter } from './editor-router.js';
import { GitScanner, type GitScannerOptions } from './git-scanner.js';
import { type LibrarySource, ProjectLibrary } from './library.js';
import { LocalChannel } from './local-channel.js';
import { Notifier, type NotifierOptions } from './notifier.js';
import { Persistence, type SessionRecord } from './persistence.js';
import {
  createTailscaleCli,
  PORT_SHARES_KEY,
  PortShares,
  type PortSharesOptions,
  registerPortShareRoutes,
  type TailscaleCli,
} from './port-shares.js';
import { ProcessScanner, type ProcessScannerOptions } from './process-scanner.js';
import {
  createCloseActions,
  createLaunchActions,
  createProjectActions,
} from './project-actions.js';
import { loadNodePty } from './pty.js';
import { PtyManager, type PtyManagerOptions } from './pty-manager.js';
import {
  DemoOutbox,
  loadVapidKeys,
  memoryVapidKeys,
  type PushSender,
  PushSubscriptions,
  registerPushRoutes,
  SUBSCRIPTIONS_KEY,
  type VapidKeys,
  webPushSender,
} from './push.js';
import { LEGACY_DEVICES_KEY, registerRemoteRoutes, remoteHosts } from './remote.js';
import { registerSecurity, signInUrl } from './security.js';
import { SessionLinker } from './session-linker.js';
import {
  BrowserSessions,
  registerSessionRoutes,
  SESSIONS_KEY,
  SESSIONS_TOKEN_KEY,
} from './sessions.js';
import {
  awaySettings,
  diskHookSettings,
  EDITOR_SEEN_KEY,
  editorCliSetting,
  HOOK_SEEN_KEY,
  type HookSettingsFile,
  LIBRARY_ROOTS_KEY,
  librarySettings,
  memoryHookSettings,
  migrateTerminalReply,
  notifySettings,
  PINNED_KEY,
  RETENTION_KEY,
  registerSettingsRoutes,
  retentionDays,
  retentionMs,
  rotateTokenFile,
  terminalReplyEnabled,
  USAGE_KEY,
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
  demo?: boolean | { seed?: number; stress?: boolean; projects?: number };
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
  /** The project library behind `GET /api/library`. Defaults to the disk, or a synthetic one in demo mode. */
  library?: LibrarySource;
  /** Editor CLI lookup and spawning, for tests (they never launch an editor). */
  editorCli?: Omit<EditorLauncherOptions, 'configured'>;
  /** Board terminal tuning: tests inject the pty loader and shell. The demo uses a synthetic shell. */
  pty?: Pick<PtyManagerOptions, 'load' | 'shell' | 'env' | 'max' | 'integrationDir'>;
  /** The `tailscale` CLI behind "Open on phone". The demo uses a simulated one. */
  tailscale?: TailscaleCli;
  /** The Vite "Blocked request" check after sharing a port, for tests. */
  portShareProbe?: PortSharesOptions['probe'];
  /** Push notification tuning: tests inject the sender (they never reach a push service). */
  push?: { send?: PushSender } & Pick<
    NotifierOptions,
    'longRunMs' | 'coalesceMs' | 'approvalGraceMs' | 'now'
  >;
  /** Runs under a file watcher (`pnpm dev`), so any edit restarts it. Reported for `doctor`. */
  watched?: boolean;
}

/** How often lapsed phone sessions are ended while nothing asks for them. */
const SESSION_SWEEP_MS = 60 * 60 * 1000;

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
    backgroundTracker: BackgroundTracker;
    gitScanner: GitScanner | null;
    ptyManager: PtyManager;
    notifier: Notifier;
    pushSubscriptions: PushSubscriptions;
    /** The socket editors and hooks use; `startServer` makes it listen. */
    localChannel: LocalChannel;
    /** Signed-in browsers and their one-time sign-in and pairing codes. */
    browserSessions: BrowserSessions;
  }
}

const ProjectParams = z.object({ projectId: ProjectId });

export async function buildServer(
  config: ServerConfig,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  // Mutable: Settings can rotate it while the server runs.
  let token = options.token ?? (await ensureToken(config.home));
  // Terminal output and transcripts live here: never readable by other users (PRD §8).
  await secureDataDir(config.home);
  const currentToken = () => token;
  const logger: FastifyBaseLogger = pino({
    name: 'yardmaster',
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
  if (!options.demo) restoreBoardSessions(store, persistence.loadSessions());
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
    // Serve entries the board made end with it; the user's own stay.
    await portShares.stop();
    notifier.stop();
    // Board terminals end with the server.
    ptyManager.stopAll();
    demo?.stop();
    worst?.stop();
    processScanner?.stop();
    sessionLinker?.stop();
    gitScanner?.stop();
    background.stop();
    // Running board sessions stay listed as interrupted, to resume on the next start.
    await runner.suspendAll();
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
  await app.register(websocket, {
    options: {
      maxPayload: MAX_UI_MESSAGE * 4,
      // The board's app also lists its session secret as a subprotocol: never echo that one.
      handleProtocols: (protocols) => (protocols.has(UI_WS_PROTOCOL) ? UI_WS_PROTOCOL : false),
    },
  });
  const sessions = new BrowserSessions({
    load: () => settings[SESSIONS_KEY],
    save: (list) => {
      settings[SESSIONS_KEY] = list;
      persistence.setSetting(SESSIONS_KEY, list);
    },
  });
  app.decorate('browserSessions', sessions);
  // Sessions belong to one token: `yardmaster token --rotate` while the board was down ends them.
  const tokenSeal = (value: string) =>
    createHash('sha256').update(`yardmaster-sessions:${value}`).digest('base64url');
  const sealSessions = () => {
    settings[SESSIONS_TOKEN_KEY] = tokenSeal(token);
    persistence.setSetting(SESSIONS_TOKEN_KEY, settings[SESSIONS_TOKEN_KEY]);
  };
  if (settings[SESSIONS_TOKEN_KEY] !== tokenSeal(token)) {
    sessions.revokeAll();
    sealSessions();
  }
  // Phones paired with a cookie before per-browser sessions pair once more.
  if (settings[LEGACY_DEVICES_KEY] !== undefined) {
    delete settings[LEGACY_DEVICES_KEY];
    persistence.setSetting(LEGACY_DEVICES_KEY, undefined);
  }
  const allowedRemoteHosts = () => remoteHosts(settings);
  registerSecurity(app, {
    config,
    token: currentToken,
    sessions,
    remote: { hosts: allowedRemoteHosts },
  });

  // Stored for history and pushed live to the Pulse rail. Nothing emits before the app is ready.
  const recordActivity = (event: ActivityEvent) => {
    persistence.recordActivity(event);
    gateway.pushActivity(event);
  };

  const background = new BackgroundTracker({ store, onActivity: recordActivity });
  app.decorate('backgroundTracker', background);

  // Constructed first so the gateway can route approvals to it; it starts once the app is ready.
  demo = options.demo
    ? new DemoSimulator({
        store,
        ...(typeof options.demo === 'object'
          ? {
              seed: options.demo.seed,
              stress: options.demo.stress,
              projects: options.demo.projects,
            }
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
  const folderTrust = new FolderTrust({
    load: () => settings[TRUSTED_FOLDERS_KEY],
    save: (list) => {
      settings[TRUSTED_FOLDERS_KEY] = list;
      persistence.setSetting(TRUSTED_FOLDERS_KEY, list);
    },
    // The demo's folders are synthetic: it never reads the disk.
    ...(options.demo ? { read: readDemoTrustFile } : {}),
  });
  const runner = new SessionRunner({
    store,
    trust: folderTrust,
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
            background.sample(tree);
            ptyManager.sample(tree);
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
  const library = options.library ?? (options.demo ? demoLibrary() : new ProjectLibrary());
  // The demo's synthetic library sits on a made-up Desktop, so the picker has folders to show.
  if (options.demo && settings[LIBRARY_ROOTS_KEY] === undefined) {
    settings[LIBRARY_ROOTS_KEY] = [DEMO_LIBRARY_ROOT];
  }
  const editorLauncher = new EditorLauncher({
    configured: () => editorCliSetting(settings),
    ...options.editorCli,
  });
  const ptyManager = new PtyManager({
    store,
    load: options.demo ? async () => demoPty() : loadNodePty,
    // The demo's shell reports its commands itself; it never runs a real one.
    ...(options.demo ? {} : { integrationDir: join(config.home, 'shell-integration') }),
    onActivity: recordActivity,
    ...options.pty,
  });
  app.decorate('ptyManager', ptyManager);
  const actions = options.actions ?? defaultActions();
  function defaultActions(): ActionHandlers {
    const roots = () => librarySettings(settings).libraryRoots;
    const editorActions = createEditorActions({
      router: editorRouter,
      send: editorGateway.sendCommand.bind(editorGateway),
    });
    const sessionActions = runner.actions();
    const boardTerminal = ptyManager.createAction();
    const demoTerminals = demo?.terminalActions();
    const handlers: ActionHandlers = {
      ...stubActionHandlers(),
      ...editorActions,
      ...sessionActions,
      ...createLaunchActions({
        store,
        library,
        roots,
        router: editorRouter,
        editorTerminal: editorActions['terminal.create'],
        boardTerminal,
        sessionCreate: sessionActions['session.create'],
      }),
      ...createProjectActions({
        store,
        library,
        roots,
        launcher: editorLauncher,
        ...(demo
          ? {
              add: (project: Project) => demo?.addProject(project, demoFolderHasGit(project.path)),
            }
          : {}),
      }),
      ...createCloseActions({
        store,
        stopTerminals: (projectId) => ptyManager.stopProject(projectId),
        suspendSessions: (projectId) => runner.suspendProject(projectId),
        closeWindows: demo
          ? async (projectId) => demo?.closeWindow(projectId) ?? { ok: true }
          : closeProjectWindows({
              state: () => store.state,
              send: editorGateway.sendCommand.bind(editorGateway),
            }),
        unpin: (projectId) => {
          const pins = settings[PINNED_KEY];
          if (!Array.isArray(pins) || !pins.includes(projectId)) return;
          const next = pins.filter((id) => id !== projectId);
          settings[PINNED_KEY] = next;
          persistence.setSetting(PINNED_KEY, next);
        },
      }),
      // Demo windows have no socket, so the simulator plays the editor's part.
      ...demo?.editorActions(),
      // Board terminals take their own actions; the rest go to the editor (or the demo).
      ...ptyManager.actions(demoTerminals ?? editorActions),
      ...(demo && demoTerminals
        ? {
            'terminal.create': (action) =>
              demo.hasWindow(action.projectId)
                ? demoTerminals['terminal.create'](action)
                : boardTerminal(action),
          }
        : {}),
    };
    return {
      ...handlers,
      ...createTerminalReply({
        state: () => store.state,
        enabled: () => terminalReplyEnabled(settings),
        sendText: handlers['terminal.sendText'],
        onChange: (listener) => store.onPatch(listener),
        notify: (message) => gateway.broadcast(message),
      }),
    };
  }

  // Board sessions, then away-mode hooks; demo approvals come from the simulator.
  const decideApproval = (decision: ApprovalDecision) => {
    let result = runner.decideApproval(decision);
    if (!result.ok) result = awayApprovals.decide(decision);
    return demo && !result.ok ? demo.decideApproval(decision) : result;
  };
  const gateway: UiGateway = new UiGateway({
    store,
    ...(transcripts ? { transcripts } : demo ? { transcripts: demo.transcripts } : {}),
    dispatch: createActionDispatcher(actions),
    decideApproval,
    sendToSession: runner.send.bind(runner),
    boardTerminals: {
      input: (terminalId, data) => ptyManager.input(terminalId, data),
      resize: (terminalId, cols, rows) => ptyManager.resize(terminalId, cols, rows),
    },
    recentActivity: () =>
      persistence.listActivity({
        since: Date.now() - HISTORY_WINDOW_MS,
        limit: MAX_ACTIVITY_BATCH,
      }),
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
  registerUiGateway(app, gateway, worstGateway, (request, socket) => {
    // A board that just opened shouldn't show a status that went stale while nobody looked.
    void discovery?.refresh();
    const session = request.browserSession();
    if (session === null) return;
    sessions.track(session, socket, WS_UNAUTHORIZED);
    // An open board counts as use; a phone's session that lapses closes its socket.
    socket.on('message', () => sessions.touch(session));
  });
  const sessionSweep = setInterval(() => sessions.sweep(), SESSION_SWEEP_MS);
  sessionSweep.unref();
  app.addHook('onClose', async () => clearInterval(sessionSweep));
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
  app.decorate('localChannel', new LocalChannel(app, logger.child({ component: 'socket' })));
  registerHookRoute(app, hookIngest);
  const statuslineStats: HookStats = { received: 0, lastAt: null };
  const savedUsage = AccountUsage.safeParse(settings[USAGE_KEY]);
  if (demo === null && savedUsage.success) store.setUsage(savedUsage.data);
  registerStatuslineRoute(app, {
    store,
    logger: logger.child({ component: 'statusline' }),
    apply: demo === null,
    onUsage: (usage) => persistence.setSetting(USAGE_KEY, usage),
    onReceived: (ts) => {
      statuslineStats.received += 1;
      statuslineStats.lastAt = ts;
    },
  });
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
  // The extension's Open Dashboard and `yardmaster open` ask here (on the socket, with the
  // token) for a one-time sign-in link, so they never open a link on a port the board doesn't hold.
  app.post(LOCAL_ROUTES.dashboardLink, async (_request, reply): Promise<DashboardLinkResponse> => {
    reply.header('cache-control', 'no-store');
    const address = app.server.address();
    const port = address !== null && typeof address === 'object' ? address.port : config.port;
    return { url: signInUrl(config, port, sessions.createSignInCode().code) };
  });
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
      statusline: { ...statuslineStats },
      setup: { hookSeen: seen(HOOK_SEEN_KEY), editorSeen: seen(EDITOR_SEEN_KEY) },
      watched: options.watched ?? false,
      boardSessions: runner.liveCount,
      boardTerminals: {
        ...(await ptyManager.availability()),
        live: ptyManager.liveCount,
        max: ptyManager.limit,
      },
      ...(demo ? {} : { editorCli: await editorLauncher.find() }),
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
      : async (caller) => {
          token = await rotateTokenFile(config.home);
          sealSessions();
          // The caller's browser stays signed in under a new session, with its notifications.
          const fresh = caller.session === null ? null : sessions.create('local', caller.userAgent);
          if (caller.session !== null && fresh) {
            pushSubscriptions.moveDevice(caller.session, fresh.session.id);
          }
          // Every other session ends, and every open socket signs in again.
          sessions.revokeAll(fresh?.session.id);
          gateway.disconnectAll(WS_UNAUTHORIZED, 'token_rotated');
          worstGateway?.disconnectAll(WS_UNAUTHORIZED, 'token_rotated');
          editorGateway.disconnectAll(WS_UNAUTHORIZED, 'token_rotated');
          return fresh ? { session: fresh.secret } : {};
        },
  });

  registerRemoteRoutes(app, { sessions, hosts: allowedRemoteHosts });
  registerSessionRoutes(app, sessions);

  // Push notifications. The demo hands them to an outbox instead of a push service.
  const pushSubscriptions = new PushSubscriptions({
    load: () => settings[SUBSCRIPTIONS_KEY],
    save: (subscriptions) => {
      settings[SUBSCRIPTIONS_KEY] = subscriptions;
      persistence.setSetting(SUBSCRIPTIONS_KEY, subscriptions);
    },
  });
  app.decorate('pushSubscriptions', pushSubscriptions);
  // A browser that is signed out gets no more notifications.
  pushSubscriptions.retainDevices((id) => sessions.has(id));
  sessions.onRevoke((id) => pushSubscriptions.removeDevice(id));
  let vapid: Promise<VapidKeys> | null = null;
  const vapidKeys = (): Promise<VapidKeys> => {
    vapid ??= (
      options.demo ? Promise.resolve(memoryVapidKeys()) : loadVapidKeys(config.home)
    ).catch((err: unknown) => {
      vapid = null;
      throw err;
    });
    return vapid;
  };
  const outbox = options.demo ? new DemoOutbox() : null;
  const { send: pushSend, ...pushTuning } = options.push ?? {};
  const notifier = new Notifier({
    store,
    subscriptions: pushSubscriptions,
    send: pushSend ?? outbox?.sender ?? webPushSender(vapidKeys),
    settings: () => {
      const notify = notifySettings(settings);
      return {
        events: new Set(notify.notifyEvents),
        hideDetails: notify.notifyHideDetails,
        muted: new Set(notify.notifyMutedProjects),
        away: awaySettings(settings).awayMode,
      };
    },
    focused: () => gateway.focusedPushIds(),
    onMessage: (message) => gateway.broadcast(message),
    logger: logger.child({ component: 'push' }),
    ...pushTuning,
  });
  app.decorate('notifier', notifier);
  registerPushRoutes(app, {
    subscriptions: pushSubscriptions,
    keys: vapidKeys,
    test: (subscription) => notifier.test(subscription.id),
    decideApproval,
    demo: outbox ? { outbox, drill: () => runPushDrill(store) } : null,
    logger: logger.child({ component: 'push' }),
  });

  const portShares = new PortShares({
    store,
    cli: options.tailscale ?? (options.demo ? demoTailscale(config.port) : createTailscaleCli()),
    load: () => settings[PORT_SHARES_KEY],
    save: (shares) => {
      settings[PORT_SHARES_KEY] = shares;
      persistence.setSetting(PORT_SHARES_KEY, shares);
    },
    // The demo simulates phone access along with Tailscale.
    phoneAccess: () => Boolean(options.demo) || allowedRemoteHosts().length > 0,
    boardPort: config.port,
    logger: logger.child({ component: 'port-shares' }),
    ...(options.portShareProbe
      ? { probe: options.portShareProbe }
      : options.demo
        ? { probe: async () => null }
        : {}),
  });
  registerPortShareRoutes(app, portShares);

  app.get('/api/library', async (): Promise<LibraryResponse> => {
    const { libraryRoots } = librarySettings(settings);
    return library.list(libraryRoots, Object.values(store.state.projects));
  });

  app.get('/api/projects/:projectId/sessions', async (request, reply) => {
    const params = ProjectParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_request' });
    const { projectId } = params.data;
    const worstHistory = worst?.sessionHistory(projectId);
    if (worstHistory) return { sessions: worstHistory } satisfies SessionHistoryResponse;
    if (!store.state.projects[projectId]) return reply.code(404).send({ error: 'unknown_project' });
    // Sessions on the board are listed there, not here.
    const onBoard = new Set(
      Object.values(store.state.sessions)
        .filter((s) => s.projectId === projectId)
        .map((s) => s.id),
    );
    const listed = demo
      ? demo.sessionHistory(projectId)
      : ((await discovery?.freshHistory(projectId, onBoard)) ?? []);
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
  void portShares.start();
  demo?.start();
  worst?.start(() => (worstGateway?.clientCount ?? 0) > 0);
  discovery?.start();
  sessionLinker?.start();
  processScanner?.start();
  gitScanner?.start();
  return app;
}

/**
 * Board sessions whose query was still open when the last server stopped (a restart, a crash):
 * listed as interrupted, with their transcript loaded from disk, until resumed. Nothing is re-sent.
 */
export function restoreBoardSessions(store: BoardStore, records: readonly SessionRecord[]): void {
  for (const { run, ...record } of records) {
    if (record.origin !== 'board' || !run || record.endedAt !== null) continue;
    store.upsertSession({
      ...record,
      status: { kind: 'interrupted', turnRunning: run === 'turn' },
    });
  }
}

/**
 * Listens on TCP (browsers) and then on the local socket in `config.home` (editors and hooks).
 * `localChannel.state` reports whether the socket came up.
 */
export async function startServer(
  config: ServerConfig,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const app = await buildServer(config, options);
  await app.listen({ port: config.port, host: config.host });
  await app.localChannel.listen(config.home);
  return app;
}
