import {
  decodeServerToEditor,
  EDITOR_CLOSE_REPLACED,
  type EditorToServer,
  encodeEditorToServer,
  makeMessage,
  type ServerToEditor,
} from '@c-board/protocol';
import WebSocket from 'ws';

export const HEARTBEAT_MS = 10_000;
export const MIN_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 30_000;
/** Offline queue caps; the oldest messages are dropped first. */
export const MAX_QUEUED_MESSAGES = 1_000;
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** Largest server → editor message (characters). */
export const MAX_SERVER_MESSAGE = 1024 * 1024;
const TOKEN_HEADER = 'x-cboard-token';

export type HelloPayload = Extract<EditorToServer, { type: 'editor.hello' }>['payload'];
type OutgoingType = Exclude<EditorToServer['type'], 'editor.hello' | 'editor.heartbeat'>;
type Outgoing<T extends EditorToServer['type']> = Extract<EditorToServer, { type: T }>;

export type LinkStatus =
  | { kind: 'stopped' }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'disconnected'; reason: string; retryInMs: number }
  /** Another connection for this window took over; no automatic retry. */
  | { kind: 'replaced' };

export interface LinkLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface EditorLinkOptions {
  url: string;
  readToken: () => Promise<string | null>;
  /** Built fresh for every connection, so folder changes are picked up. */
  hello: () => HelloPayload;
  onStatus?: (status: LinkStatus) => void;
  onCommand?: (command: ServerToEditor) => void;
  logger?: LinkLogger;
  heartbeatMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  maxQueuedMessages?: number;
  maxQueuedBytes?: number;
  random?: () => number;
}

/** Exponential backoff with ±25 % jitter. `attempt` counts failures since the last success. */
export function backoffDelay(
  attempt: number,
  minMs = MIN_BACKOFF_MS,
  maxMs = MAX_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random() * 0.5));
}

const silentLogger: LinkLogger = { info() {}, warn() {}, debug() {} };

/**
 * The extension's connection to `/ws/editor`: sends `editor.hello` on every connect,
 * heartbeats while connected, reconnects with backoff, and queues messages while offline.
 */
export class EditorLink {
  private readonly options: EditorLinkOptions;
  private readonly log: LinkLogger;
  private socket: WebSocket | null = null;
  /** Bumped on every connect and stop, so callbacks from older sockets are ignored. */
  private generation = 0;
  private running = false;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private awaitingPong = false;
  private queue: string[] = [];
  private queuedBytes = 0;
  private droppedCount = 0;
  private current: LinkStatus = { kind: 'stopped' };

  constructor(options: EditorLinkOptions) {
    this.options = options;
    this.log = options.logger ?? silentLogger;
  }

  get status(): LinkStatus {
    return this.current;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Messages dropped from the full offline queue since the link was created. */
  get dropped(): number {
    return this.droppedCount;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.teardown(1000, 'editor link stopped');
    this.queue = [];
    this.queuedBytes = 0;
    this.setStatus({ kind: 'stopped' });
  }

  /** Drops the current connection (if any) and connects again right away. */
  reconnect(): void {
    this.running = true;
    this.failures = 0;
    this.generation += 1;
    this.teardown(1000, 'reconnecting');
    void this.connect();
  }

  /** Re-sends `editor.hello`, e.g. after the workspace folders changed. */
  sendHello(): void {
    if (this.isOpen()) this.write(this.encode('editor.hello', this.options.hello()));
  }

  /** Sends now, or queues until the next connection. Dropped while stopped. */
  send<T extends OutgoingType>(type: T, payload: Outgoing<T>['payload']): void {
    if (!this.running) return;
    const data = this.encode(type, payload);
    if (data === undefined) return;
    if (this.isOpen()) this.write(data);
    else this.enqueue(data);
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.setStatus({ kind: 'connecting' });

    const token = await this.options.readToken().catch(() => null);
    if (generation !== this.generation) return;
    if (token === null) {
      this.retry(generation, 'no token yet (is the c-board server installed?)');
      return;
    }

    let reason: string | null = null;
    const socket = new WebSocket(this.options.url, {
      headers: { [TOKEN_HEADER]: token },
      maxPayload: MAX_SERVER_MESSAGE * 4,
      handshakeTimeout: 5_000,
    });
    this.socket = socket;

    socket.on('unexpected-response', (_request, response) => {
      reason ??=
        response.statusCode === 401
          ? 'the server rejected the token'
          : `HTTP ${response.statusCode}`;
      // Aborts the handshake, which emits `error` and then `close`.
      socket.terminate();
    });
    socket.on('open', () => {
      if (generation !== this.generation) return;
      this.failures = 0;
      this.write(this.encode('editor.hello', this.options.hello()));
      this.flushQueue();
      this.startHeartbeat(socket);
      this.setStatus({ kind: 'connected' });
      this.log.info('connected to the c-board server');
    });
    socket.on('message', (data, isBinary) => {
      if (generation !== this.generation || isBinary) return;
      const decoded = decodeServerToEditor(data.toString(), { maxLength: MAX_SERVER_MESSAGE });
      if (!decoded.ok) {
        this.log.warn(`ignored invalid server message: ${decoded.reason}`);
        return;
      }
      this.options.onCommand?.(decoded.message);
    });
    socket.on('pong', () => {
      this.awaitingPong = false;
    });
    socket.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      reason ??= code === 'ECONNREFUSED' ? 'the server is not running' : error.message;
    });
    socket.on('close', (code) => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.stopHeartbeat();
      if (code === EDITOR_CLOSE_REPLACED) {
        this.log.warn('another connection for this window took over');
        this.setStatus({ kind: 'replaced' });
        return;
      }
      this.retry(generation, reason ?? 'the server closed the connection');
    });
  }

  private retry(generation: number, reason: string): void {
    if (!this.running || generation !== this.generation || this.retryTimer) return;
    const retryInMs = backoffDelay(
      this.failures,
      this.options.minBackoffMs,
      this.options.maxBackoffMs,
      this.options.random,
    );
    this.failures += 1;
    this.log.debug(`disconnected (${reason}); retrying in ${retryInMs} ms`);
    this.setStatus({ kind: 'disconnected', reason, retryInMs });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.running && generation === this.generation) void this.connect();
    }, retryInMs);
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      // No pong since the last beat: the server is gone without closing the socket.
      if (this.awaitingPong) {
        this.log.warn('the server stopped answering; reconnecting');
        socket.terminate();
        return;
      }
      this.awaitingPong = true;
      socket.ping();
      this.write(this.encode('editor.heartbeat', {}));
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private teardown(code: number, reason: string): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }

  private enqueue(data: string): void {
    const maxMessages = this.options.maxQueuedMessages ?? MAX_QUEUED_MESSAGES;
    const maxBytes = this.options.maxQueuedBytes ?? MAX_QUEUED_BYTES;
    if (data.length > maxBytes) {
      this.droppedCount += 1;
      return;
    }
    this.queue.push(data);
    this.queuedBytes += data.length;
    let dropped = 0;
    while (this.queue.length > maxMessages || this.queuedBytes > maxBytes) {
      this.queuedBytes -= this.queue.shift()?.length ?? 0;
      dropped += 1;
    }
    if (dropped > 0) {
      if (this.droppedCount === 0) this.log.warn('offline queue is full; dropping oldest messages');
      this.droppedCount += dropped;
    }
  }

  private flushQueue(): void {
    const queue = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const data of queue) this.write(data);
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.current.kind === 'connected';
  }

  private write(data: string | undefined): void {
    if (data !== undefined && this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
  }

  private encode<T extends EditorToServer['type']>(
    type: T,
    payload: Outgoing<T>['payload'],
  ): string | undefined {
    const encoded = encodeEditorToServer(
      makeMessage<Outgoing<T>>(type as Outgoing<T>['type'], payload),
    );
    if (encoded.ok) return encoded.data;
    this.log.warn(`dropped invalid ${type} message: ${encoded.reason}`);
    return undefined;
  }

  private setStatus(status: LinkStatus): void {
    const same =
      status.kind === this.current.kind && JSON.stringify(status) === JSON.stringify(this.current);
    this.current = status;
    if (!same) this.options.onStatus?.(status);
  }
}
