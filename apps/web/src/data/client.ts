import {
  decodeServerToUi,
  encodeUiToServer,
  makeMessage,
  type ServerToUi,
  type StreamId,
  type UiAction,
  type UiToServer,
} from '@c-board/protocol';
import type { BoardStore } from './store.js';

/** The slice of the browser WebSocket the client needs, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export interface Logger {
  warn(message: string, detail?: unknown): void;
}

export interface BoardClientOptions {
  url: string;
  store: BoardStore;
  createSocket?: (url: string) => SocketLike;
  /** First retry delay; doubles per failed attempt. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** How long `request` waits for its `action.result`. */
  requestTimeoutMs?: number;
  /** [0, 1); used for retry jitter. */
  random?: () => number;
  logger?: Logger;
}

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Delay before retry number `attempt` (1-based): exponential from `base`, capped at
 * `max`, with up to 20% jitter taken off so many tabs don't retry in lockstep.
 */
export function backoffDelay(
  attempt: number,
  base = BASE_DELAY_MS,
  max = MAX_DELAY_MS,
  random = Math.random,
): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (1 - 0.2 * random()));
}

export interface ChunkInfo {
  seq: number;
  /** Output between the previous chunk and this one was lost (the server buffer wrapped). */
  gap: boolean;
}

export type ChunkListener = (chunk: string, info: ChunkInfo) => void;

export type RequestResult = { ok: true } | { ok: false; error: string };

type RequestMessage = Extract<UiToServer, { type: 'action' | 'session.send' | 'approval.decide' }>;

interface StreamEntry {
  listeners: Set<ChunkListener>;
  /** The next seq we expect; earlier chunks are replays we already delivered. */
  nextSeq: number;
  /** Nothing delivered yet, so the first chunk can't be a gap. */
  fresh: boolean;
}

interface Pending {
  resolve(result: RequestResult): void;
  timer: ReturnType<typeof setTimeout>;
}

type MessageListener = (message: ServerToUi) => void;

const consoleLogger: Logger = {
  warn: (message, detail) => console.warn(`[c-board] ${message}`, detail ?? ''),
};

/**
 * The `/ws/ui` connection: keeps the board store in sync (snapshot, then patches),
 * reconnects with exponential backoff, and fans stream output out to listeners
 * without going through React state.
 */
export class BoardClient {
  private readonly url: string;
  private readonly store: BoardStore;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly random: () => number;
  private readonly log: Logger;

  private socket: SocketLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private running = false;
  private synced = false;
  private nextRequestId = 1;
  private readonly streams = new Map<StreamId, StreamEntry>();
  private readonly pending = new Map<string, Pending>();
  private readonly messageListeners = new Set<MessageListener>();

  constructor(options: BoardClientOptions) {
    this.url = options.url;
    this.store = options.store;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.random = options.random ?? Math.random;
    this.log = options.logger ?? consoleLogger;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.dropSocket();
    this.failPending('disconnected');
    this.store.getState().setConnection({ status: 'stopped', retryAt: null });
  }

  /** Skips the remaining backoff, e.g. when the browser comes back online. */
  reconnectNow(): void {
    if (!this.running || this.socket) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connect();
  }

  /**
   * Delivers output of `streamId` to `listener`, replaying what the server still
   * buffers. Survives reconnects and resyncs without duplicates. Returns the unsubscribe.
   */
  subscribeStream(streamId: StreamId, listener: ChunkListener): () => void {
    let entry = this.streams.get(streamId);
    if (!entry) {
      entry = { listeners: new Set(), nextSeq: 0, fresh: true };
      this.streams.set(streamId, entry);
      this.sendSubscribe(streamId, entry);
    }
    entry.listeners.add(listener);
    return () => {
      const current = this.streams.get(streamId);
      if (!current?.listeners.delete(listener) || current.listeners.size > 0) return;
      this.streams.delete(streamId);
      this.send(makeMessage<UiToServer>('unsubscribe', { streamId }));
    };
  }

  /** Board-level messages other than state sync (toasts, approvals, …). */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Sends an action and resolves with the server's `action.result`. Never rejects. */
  action(action: UiAction): Promise<RequestResult> {
    return this.request('action', action);
  }

  request<T extends RequestMessage['type']>(
    type: T,
    payload: Extract<RequestMessage, { type: T }>['payload'],
  ): Promise<RequestResult> {
    if (!this.synced) return Promise.resolve({ ok: false, error: 'offline' });
    const id = `ui-${this.nextRequestId++}`;
    if (!this.send(makeMessage<UiToServer>(type, payload as UiToServer['payload'], { id }))) {
      return Promise.resolve({ ok: false, error: 'invalid_message' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  private connect(): void {
    this.store.getState().setConnection({
      status: this.attempt === 0 ? 'connecting' : 'reconnecting',
      retryAt: null,
    });
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch (error) {
      this.log.warn('could not open the board socket', error);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.store.getState().setConnection({ status: 'syncing' });
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.onRaw(event.data);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.synced = false;
      this.failPending('disconnected');
      if (this.running) this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    this.attempt++;
    const delay = backoffDelay(this.attempt, this.baseDelayMs, this.maxDelayMs, this.random);
    this.store.getState().setConnection({
      status: 'reconnecting',
      attempt: this.attempt,
      retryAt: Date.now() + delay,
    });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.running) this.connect();
    }, delay);
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.synced = false;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000, 'client stopped');
    } catch {
      // Already closing.
    }
  }

  private onRaw(raw: unknown): void {
    if (typeof raw !== 'string') {
      this.log.warn('ignored non-text board message');
      return;
    }
    const decoded = decodeServerToUi(raw);
    if (!decoded.ok) {
      this.log.warn('ignored invalid board message', decoded.reason);
      return;
    }
    const message = decoded.message;
    switch (message.type) {
      case 'snapshot':
        this.onSnapshot(message);
        return;
      case 'patch':
        if (!this.synced) {
          this.log.warn('ignored patch before snapshot');
          return;
        }
        this.store.getState().applyOps(message.payload.ops);
        return;
      case 'stream.data':
        this.onStreamData(message.payload.streamId, message.payload.seq, message.payload.chunk);
        return;
      case 'stream.resync': {
        const entry = this.streams.get(message.payload.streamId);
        if (entry) this.sendSubscribe(message.payload.streamId, entry);
        return;
      }
      case 'action.result': {
        const pending = this.pending.get(message.payload.id);
        if (!pending) return;
        this.pending.delete(message.payload.id);
        clearTimeout(pending.timer);
        const { ok, error } = message.payload;
        pending.resolve(ok ? { ok: true } : { ok: false, error: error ?? 'action_failed' });
        return;
      }
      default:
        for (const listener of this.messageListeners) listener(message);
    }
  }

  private onSnapshot(message: Extract<ServerToUi, { type: 'snapshot' }>): void {
    const firstSync = !this.synced;
    this.synced = true;
    this.attempt = 0;
    const state = this.store.getState();
    state.replaceBoard(message.payload.state);
    state.setConnection({ status: 'live', attempt: 0, retryAt: null, syncedAt: Date.now() });
    // The server forgets subscriptions with the socket; resume each where we left off.
    if (!firstSync) return;
    for (const [streamId, entry] of this.streams) this.sendSubscribe(streamId, entry);
  }

  private onStreamData(streamId: StreamId, seq: number, chunk: string): void {
    const entry = this.streams.get(streamId);
    if (!entry || seq < entry.nextSeq) return;
    const gap = !entry.fresh && seq > entry.nextSeq;
    entry.fresh = false;
    entry.nextSeq = seq + 1;
    for (const listener of entry.listeners) {
      try {
        listener(chunk, { seq, gap });
      } catch (error) {
        this.log.warn('stream listener failed', error);
      }
    }
  }

  private sendSubscribe(streamId: StreamId, entry: StreamEntry): void {
    if (!this.synced) return;
    const payload = entry.fresh ? { streamId } : { streamId, fromSeq: entry.nextSeq };
    this.send(makeMessage<UiToServer>('subscribe', payload));
  }

  private send(message: UiToServer): boolean {
    const encoded = encodeUiToServer(message);
    if (!encoded.ok) {
      this.log.warn('dropped invalid outgoing message', encoded.reason);
      return false;
    }
    if (this.socket?.readyState === OPEN) this.socket.send(encoded.data);
    return true;
  }

  private failPending(error: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
    this.pending.clear();
  }
}
