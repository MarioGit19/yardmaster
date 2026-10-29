import { randomUUID } from 'node:crypto';
import {
  type ActivityEvent,
  decodeEditorToServer,
  EDITOR_CLOSE_REPLACED,
  type EditorTerminal,
  type EditorToServer,
  encodeServerToEditor,
  LOCAL_ROUTES,
  makeMessage,
  type ServerToEditor,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ActionResult } from './actions.js';
import { ensureProject, type PathResolver, resolveDir } from './claude/project-lookup.js';
import { applyExecEvent, type ExecEvent, endRunning } from './exec-reducer.js';
import { tokenHeader } from './security.js';
import type { BoardStore } from './store.js';
import { type TerminalEvent, terminalReducer } from './terminal-reducer.js';
import { tokensEqual } from './token.js';

export const EDITOR_WS_PATH = LOCAL_ROUTES.editor;
/** A window that drops its connection keeps its terminals this long, so a reconnect is seamless. */
export const WINDOW_GRACE_MS = 15_000;
/** Editors send a heartbeat every 10 s; a socket silent for this long is dropped. */
export const EDITOR_IDLE_MS = 35_000;
/** Largest editor → server message (characters). */
export const MAX_EDITOR_MESSAGE = 1024 * 1024;
/** How long an editor has to acknowledge a command with `cmd.result`. */
export const COMMAND_TIMEOUT_MS = 5_000;

export const COMMAND_ERRORS = {
  timeout: 'editor_timeout',
  offline: 'editor_offline',
  disconnected: 'editor_disconnected',
  invalid: 'invalid_command',
  failed: 'command_failed',
  shuttingDown: 'server_shutting_down',
} as const;

export interface EditorGatewayOptions {
  store: BoardStore;
  logger: FastifyBaseLogger;
  graceMs?: number;
  idleMs?: number;
  resolvePath?: PathResolver;
  now?: () => number;
  /** False in demo mode: sockets are accepted (so editors don't retry) but nothing is applied. */
  apply?: boolean;
  /** Receives `exec.start` / `exec.end` for the Pulse timeline. */
  onActivity?: (event: ActivityEvent) => void;
  commandTimeoutMs?: number;
}

type Command<T extends ServerToEditor['type']> = Extract<ServerToEditor, { type: T }>;
export type CommandPayloads = { [K in ServerToEditor['type']]: Command<K>['payload'] };

interface PendingCommand {
  connection: Connection;
  timer: NodeJS.Timeout;
  resolve: (result: ActionResult) => void;
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
 * folders as projects, keeps its terminal inventory and execution output, sends it commands
 * (acknowledged with `cmd.result`), and removes the window (with its terminals) once it has
 * been gone for the grace period.
 */
export class EditorGateway {
  private readonly store: BoardStore;
  private readonly log: FastifyBaseLogger;
  private readonly graceMs: number;
  private readonly idleMs: number;
  private readonly resolvePath: PathResolver;
  private readonly now: () => number;
  private readonly apply: boolean;
  private readonly onActivity: ((event: ActivityEvent) => void) | undefined;
  private readonly connections = new Set<Connection>();
  private readonly windows = new Map<string, WindowEntry>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly commandTimeoutMs: number;

  constructor(options: EditorGatewayOptions) {
    this.store = options.store;
    this.log = options.logger;
    this.graceMs = options.graceMs ?? WINDOW_GRACE_MS;
    this.idleMs = options.idleMs ?? EDITOR_IDLE_MS;
    this.resolvePath = options.resolvePath ?? resolveDir;
    this.now = options.now ?? Date.now;
    this.apply = options.apply ?? true;
    this.onActivity = options.onActivity;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  }

  /** True while the window has a live connection that has sent `editor.hello`. */
  isConnected(windowId: string): boolean {
    const connection = this.windows.get(windowId)?.connection;
    return !!connection && !connection.closed && connection.windowId === windowId;
  }

  /**
   * Sends a command to a window and resolves with its `cmd.result`, or with an error once the
   * editor disconnects or the timeout passes. Never rejects.
   */
  sendCommand<T extends ServerToEditor['type']>(
    windowId: string,
    type: T,
    payload: CommandPayloads[T],
  ): Promise<ActionResult> {
    const connection = this.windows.get(windowId)?.connection;
    if (!connection || !this.isConnected(windowId)) {
      return Promise.resolve({ ok: false, error: COMMAND_ERRORS.offline });
    }
    const id = randomUUID();
    const encoded = encodeServerToEditor(
      makeMessage<ServerToEditor>(type, payload as ServerToEditor['payload'], {
        id,
        ts: this.now(),
      }),
    );
    if (!encoded.ok) {
      this.log.warn({ type, reason: encoded.reason }, 'refused an invalid editor command');
      return Promise.resolve({ ok: false, error: COMMAND_ERRORS.invalid });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log.warn({ type }, 'editor command timed out');
        resolve({ ok: false, error: COMMAND_ERRORS.timeout });
      }, this.commandTimeoutMs);
      this.pending.set(id, { connection, timer, resolve });
      connection.socket.send(encoded.data, (error) => {
        if (error) this.settle(id, { ok: false, error: COMMAND_ERRORS.disconnected });
      });
    });
  }

  private settle(id: string, result: ActionResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private settleConnection(connection: Connection, error: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.connection === connection) this.settle(id, { ok: false, error });
    }
  }

  private onCommandResult(
    connection: Connection,
    result: Extract<EditorToServer, { type: 'cmd.result' }>['payload'],
  ): void {
    const pending = this.pending.get(result.id);
    if (!pending || pending.connection !== connection) {
      this.log.debug('ignored a cmd.result for an unknown command');
      return;
    }
    this.settle(
      result.id,
      result.ok ? { ok: true } : { ok: false, error: result.error ?? COMMAND_ERRORS.failed },
    );
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

  /** Closes every editor socket (token rotation): editors reconnect with the new token. */
  disconnectAll(code: number, reason: string): void {
    for (const connection of this.connections) connection.socket.close(code, reason);
  }

  close(): void {
    for (const entry of this.windows.values()) clearTimeout(entry.removeTimer);
    this.windows.clear();
    for (const connection of this.connections) {
      connection.closed = true;
      clearTimeout(connection.idleTimer);
      this.settleConnection(connection, COMMAND_ERRORS.shuttingDown);
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
      case 'exec.start':
        return this.applyExec(connection.windowId, { type: 'start', ...message.payload });
      case 'exec.data':
        return this.applyExec(connection.windowId, { type: 'data', ...message.payload });
      case 'exec.interactive':
        return this.applyExec(connection.windowId, { type: 'interactive', ...message.payload });
      case 'exec.end':
        return this.applyExec(connection.windowId, { type: 'end', ...message.payload });
      case 'cmd.result':
        return this.onCommandResult(connection, message.payload);
    }
  }

  private applyExec(windowId: string, event: ExecEvent): void {
    const ts = this.now();
    const outcome = applyExecEvent(this.store, windowId, event, ts);
    if (!outcome.applied) {
      this.log.debug({ type: event.type, reason: outcome.reason }, 'ignored an execution event');
      return;
    }
    if (event.type !== 'start' && event.type !== 'end') return;
    const { execution } = outcome;
    const terminal = this.store.state.terminals[execution.terminalId];
    this.onActivity?.({
      id: randomUUID(),
      ts,
      kind: event.type === 'start' ? 'exec.start' : 'exec.end',
      projectId: terminal?.projectId ?? null,
      sessionId: null,
      terminalId: execution.terminalId,
      execId: execution.id,
      summary: execution.commandLine.slice(0, 200) || null,
      data: event.type === 'end' ? { exitCode: execution.exitCode } : {},
    });
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
      this.settleConnection(previous, COMMAND_ERRORS.disconnected);
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
      capabilities: message.payload.capabilities,
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
    const { executionIds, ...fields } = next;
    this.store.upsertTerminal(fields);
    if (next.state === 'closed') endRunning(this.store, executionIds, this.now());
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
    this.settleConnection(connection, COMMAND_ERRORS.disconnected);
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

/**
 * `/ws/editor`: on the local socket only, with the install token in the `X-Yardmaster-Token`
 * header (PRD §8).
 */
export function registerEditorGateway(
  app: FastifyInstance,
  gateway: EditorGateway,
  token: string | (() => string),
): void {
  const currentToken = typeof token === 'function' ? token : () => token;
  app.get(
    EDITOR_WS_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        // Editors run on this machine; the token never counts over Tailscale (PRD §8 item 12).
        if (request.isRemote() || !request.isLocalChannel()) {
          return reply.code(403).send({ error: 'local_only' });
        }
        const header = tokenHeader(request.headers);
        if (header === undefined || !tokensEqual(header, currentToken())) {
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
