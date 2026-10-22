import {
  decodeEditorToServer,
  EDITOR_CLOSE_REPLACED,
  type EditorTerminal,
  type EditorToServer,
} from '@c-board/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ensureProject, type PathResolver, resolveDir } from './claude/project-lookup.js';
import { TOKEN_HEADER } from './security.js';
import type { BoardStore } from './store.js';
import { type TerminalEvent, terminalReducer } from './terminal-reducer.js';
import { tokensEqual } from './token.js';

export const EDITOR_WS_PATH = '/ws/editor';
/** A window that drops its connection keeps its terminals this long, so a reconnect is seamless. */
export const WINDOW_GRACE_MS = 15_000;
/** Editors send a heartbeat every 10 s; a socket silent for this long is dropped. */
export const EDITOR_IDLE_MS = 35_000;
/** Largest editor → server message (characters). */
export const MAX_EDITOR_MESSAGE = 1024 * 1024;

export interface EditorGatewayOptions {
  store: BoardStore;
  logger: FastifyBaseLogger;
  graceMs?: number;
  idleMs?: number;
  resolvePath?: PathResolver;
  now?: () => number;
  /** False in demo mode: sockets are accepted (so editors don't retry) but nothing is applied. */
  apply?: boolean;
}

interface Connection {
  socket: WebSocket;
  windowId: string | null;
  closed: boolean;
  /** Messages are handled in order, even though `editor.hello` resolves paths asynchronously. */
  queue: Promise<void>;
  idleTimer: NodeJS.Timeout | undefined;
}

interface WindowEntry {
  connection: Connection | null;
  removeTimer: NodeJS.Timeout | undefined;
}

/**
 * Accepts extension connections on `/ws/editor`: registers each window and its workspace
 * folders as projects, keeps its terminal inventory, and removes the window (with its terminals) once it has been gone
 * for the grace period.
 */
export class EditorGateway {
  private readonly store: BoardStore;
  private readonly log: FastifyBaseLogger;
  private readonly graceMs: number;
  private readonly idleMs: number;
  private readonly resolvePath: PathResolver;
  private readonly now: () => number;
  private readonly apply: boolean;
  private readonly connections = new Set<Connection>();
  private readonly windows = new Map<string, WindowEntry>();

  constructor(options: EditorGatewayOptions) {
    this.store = options.store;
    this.log = options.logger;
    this.graceMs = options.graceMs ?? WINDOW_GRACE_MS;
    this.idleMs = options.idleMs ?? EDITOR_IDLE_MS;
    this.resolvePath = options.resolvePath ?? resolveDir;
    this.now = options.now ?? Date.now;
    this.apply = options.apply ?? true;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Resolves once every message received so far has been applied. */
  async idle(): Promise<void> {
    await Promise.all([...this.connections].map((connection) => connection.queue));
  }

  connect(socket: WebSocket): void {
    const connection: Connection = {
      socket,
      windowId: null,
      closed: false,
      queue: Promise.resolve(),
      idleTimer: undefined,
    };
    this.connections.add(connection);
    this.resetIdle(connection);

    socket.on('message', (data, isBinary) => {
      this.resetIdle(connection);
      if (isBinary) {
        this.log.warn('ignored binary editor message');
        return;
      }
      const decoded = decodeEditorToServer(data.toString(), { maxLength: MAX_EDITOR_MESSAGE });
      if (!decoded.ok) {
        this.log.warn({ reason: decoded.reason }, 'ignored invalid editor message');
        return;
      }
      if (!this.apply) return;
      const message = decoded.message;
      connection.queue = connection.queue
        .then(() => this.onMessage(connection, message))
        .catch((error: unknown) => this.log.error({ err: error }, 'editor message failed'));
    });
    socket.on('close', () => this.onClose(connection));
    socket.on('error', (error) => this.log.debug({ err: error }, 'editor socket error'));
  }

  close(): void {
    for (const entry of this.windows.values()) clearTimeout(entry.removeTimer);
    this.windows.clear();
    for (const connection of this.connections) {
      connection.closed = true;
      clearTimeout(connection.idleTimer);
      connection.socket.close(1001, 'server shutting down');
    }
    this.connections.clear();
  }

  private async onMessage(connection: Connection, message: EditorToServer): Promise<void> {
    if (message.type === 'editor.hello') return this.onHello(connection, message);
    if (connection.windowId === null) {
      this.log.warn({ type: message.type }, 'ignored editor message before editor.hello');
      return;
    }
    switch (message.type) {
      case 'editor.heartbeat':
        this.store.touchWindow(connection.windowId, this.now());
        return;
      case 'terminal.upsert':
        await this.applyTerminal(connection.windowId, message.payload.terminalId, {
          type: 'upsert',
          terminal: message.payload,
        });
        return;
      case 'terminal.closed':
        await this.applyTerminal(connection.windowId, message.payload.terminalId, {
          type: 'closed',
          exitCode: message.payload.exitCode,
        });
        return;
      case 'terminal.sync':
        return this.onSync(connection.windowId, message.payload.terminals);
      default:
        // Executions and command results are handled by later tasks (5.4+).
        this.log.debug({ type: message.type }, 'editor message not handled yet');
    }
  }

  private async onHello(
    connection: Connection,
    message: Extract<EditorToServer, { type: 'editor.hello' }>,
  ): Promise<void> {
    const { windowId } = message.payload;
    if (connection.windowId !== null && connection.windowId !== windowId) {
      this.log.warn('ignored editor.hello that changes the window id of a connection');
      return;
    }
    if (connection.closed) return;

    const entry = this.windows.get(windowId) ?? { connection: null, removeTimer: undefined };
    this.windows.set(windowId, entry);
    clearTimeout(entry.removeTimer);
    entry.removeTimer = undefined;
    const previous = entry.connection;
    if (previous && previous !== connection) {
      // The same window reconnected before its old socket noticed it was gone.
      previous.windowId = null;
      previous.socket.close(EDITOR_CLOSE_REPLACED, 'replaced by a newer connection');
    }
    entry.connection = connection;
    connection.windowId = windowId;

    const ts = this.now();
    const projectIds: string[] = [];
    for (const folder of message.payload.workspaceFolders) {
      const path = await this.resolvePath(folder).catch(() => null);
      if (path === null) {
        this.log.debug('skipped a workspace folder that is not an absolute path');
        continue;
      }
      const id = ensureProject(this.store, path, 'editor', ts);
      if (!projectIds.includes(id)) projectIds.push(id);
    }
    // The socket may have closed or been replaced while paths were resolving.
    if (entry.connection !== connection || connection.closed) return;

    const existing = this.store.state.windows[windowId];
    this.store.upsertWindow({
      id: windowId,
      appName: message.payload.appName,
      appVersion: message.payload.appVersion,
      extensionVersion: message.payload.extensionVersion,
      workspaceFolders: message.payload.workspaceFolders,
      projectIds,
      connectedAt: existing && previous === connection ? existing.connectedAt : ts,
      lastSeenAt: ts,
    });
    for (const id of projectIds) this.store.touchProject(id, ts);
    this.log.info({ projects: projectIds.length }, 'editor window connected');
  }

  private async applyTerminal(
    windowId: string,
    terminalId: string,
    event: TerminalEvent,
  ): Promise<void> {
    const existing = this.store.state.terminals[terminalId];
    const cwd = event.type === 'upsert' ? (event.terminal.cwd ?? existing?.cwd) : null;
    const resolvedCwd = cwd ? await this.resolvePath(cwd).catch(() => null) : null;
    // Re-read: the store may have changed while the path was resolving.
    const current = this.store.state.terminals[terminalId];
    const next = terminalReducer(current, event, {
      windowId,
      projects: this.store.state.projects,
      windowProjectIds: this.store.state.windows[windowId]?.projectIds ?? [],
      resolvedCwd,
      now: this.now(),
    });
    if (next === null) {
      this.log.debug({ type: event.type }, 'ignored a terminal event for an unknown terminal');
      return;
    }
    const { executionIds: _, ...fields } = next;
    this.store.upsertTerminal(fields);
  }

  /** Replaces the window's terminal list: listed terminals are upserted, the rest removed. */
  private async onSync(windowId: string, terminals: readonly EditorTerminal[]): Promise<void> {
    const listed = new Set<string>();
    for (const terminal of terminals) {
      listed.add(terminal.terminalId);
      await this.applyTerminal(windowId, terminal.terminalId, { type: 'upsert', terminal });
    }
    for (const terminal of Object.values(this.store.state.terminals)) {
      if (terminal.windowId === windowId && !listed.has(terminal.id)) {
        this.store.removeTerminal(terminal.id);
      }
    }
  }

  private onClose(connection: Connection): void {
    connection.closed = true;
    clearTimeout(connection.idleTimer);
    this.connections.delete(connection);
    const windowId = connection.windowId;
    if (windowId === null) return;
    const entry = this.windows.get(windowId);
    if (!entry || entry.connection !== connection) return;
    entry.connection = null;
    entry.removeTimer = setTimeout(() => {
      this.windows.delete(windowId);
      this.store.removeWindow(windowId);
      this.log.info('editor window removed after disconnect');
    }, this.graceMs);
  }

  private resetIdle(connection: Connection): void {
    clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => {
      this.log.warn('dropped a silent editor connection');
      connection.socket.terminate();
    }, this.idleMs);
  }
}

/** `/ws/editor`: the install token must arrive in the `X-CBoard-Token` header (PRD §8). */
export function registerEditorGateway(
  app: FastifyInstance,
  gateway: EditorGateway,
  token: string,
): void {
  app.get(
    EDITOR_WS_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const header = request.headers[TOKEN_HEADER];
        if (typeof header !== 'string' || !tokensEqual(header, token)) {
          return reply.code(401).send({ error: 'unauthorized' });
        }
      },
    },
    (socket) => gateway.connect(socket),
  );
  app.addHook('preClose', async () => gateway.close());
}

declare module 'fastify' {
  interface FastifyInstance {
    editorGateway: EditorGateway;
  }
}
