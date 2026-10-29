import {
  decodeServerToUi,
  type EditorApp,
  encodeUiToServer,
  type FolderTrustReview,
  makeMessage,
  type ServerToUi,
  type StreamId,
  type UiAction,
  type UiToServer,
  WS_UNAUTHORIZED,
} from '@yardmaster/protocol';
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

/** How the socket signs in: subprotocols carrying the session, and what to do when refused. */
export interface SocketAuth {
  protocols(): string[];
  /** The board closed the socket with `WS_UNAUTHORIZED`; `protocols` are the ones it refused. */
  refused(protocols: readonly string[]): void;
}

export interface BoardClientOptions {
  url: string;
  store: BoardStore;
  createSocket?: (url: string, protocols: string[]) => SocketLike;
  auth?: SocketAuth;
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
/** Per open stream, how much recent output a late listener gets replayed (UTF-16 units). */
export const STREAM_HISTORY_CHARS = 2_000_000;
/** Longest `terminal.input` message; a bigger paste goes in several. */
export const MAX_TERMINAL_INPUT = 64 * 1024;

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

/**
 * `sessionId`: the session the action started, if any. `editor`: the editor a launch opened.
 * `trust`: the folder a board session needs trusted first.
 */
export type RequestResult =
  | { ok: true; sessionId?: string; editor?: EditorApp }
  | { ok: false; error: string; trust?: FolderTrustReview };

/** Asks the user to trust a folder; resolves `true` to trust it and retry. */
export type TrustGate = (review: FolderTrustReview) => Promise<boolean>;

export type ActionListener = (action: UiAction, result: RequestResult) => void;

type RequestMessage = Extract<UiToServer, { type: 'action' | 'session.send' | 'approval.decide' }>;

interface StreamEntry {
  listeners: Set<ChunkListener>;
  /** The next seq we expect; earlier chunks are replays we already delivered. */
  nextSeq: number;
  /** Nothing delivered yet, so the first chunk can't be a gap. */
  fresh: boolean;
  /** Recent chunks, replayed to listeners that join an already open stream. */
  history: { seq: number; chunk: string }[];
  historyChars: number;
}

interface Pending {
  resolve(result: RequestResult): void;
  timer: ReturnType<typeof setTimeout>;
}

type MessageListener = (message: ServerToUi) => void;

const consoleLogger: Logger = {
  warn: (message, detail) => console.warn(`[yardmaster] ${message}`, detail ?? ''),
};

/**
 * The `/ws/ui` connection: keeps the board store in sync (snapshot, then patches),
 * reconnects with exponential backoff, and fans stream output out to listeners
 * without going through React state.
 */
export class BoardClient {
  private readonly url: string;
  private readonly store: BoardStore;
  private readonly createSocket: (url: string, protocols: string[]) => SocketLike;
  private readonly auth: SocketAuth | undefined;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly random: () => number;
  private readonly log: Logger;

  private socket: SocketLike | null = null;
  private trustGate: TrustGate | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private running = false;
  private synced = false;
  private presence: { focused: boolean; pushId: string | null } = { focused: false, pushId: null };
  private nextRequestId = 1;
  private readonly streams = new Map<StreamId, StreamEntry>();
  private readonly pending = new Map<string, Pending>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly actionListeners = new Set<ActionListener>();

  constructor(options: BoardClientOptions) {
    this.url = options.url;
    this.store = options.store;
    this.createSocket =
      options.createSocket ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
    this.auth = options.auth;
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

  /** Connects again after a sign-in, if the board had refused this browser. */
  resume(): void {
    if (!this.running || this.socket) return;
    if (this.store.getState().connection.status !== 'signedOut') return;
    this.attempt = 0;
    this.connect();
  }

  /** Skips the remaining backoff, e.g. when the browser comes back online. */
  reconnectNow(): void {
    if (!this.running || this.socket) return;
    if (this.store.getState().connection.status === 'signedOut') return;
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
      entry = { listeners: new Set(), nextSeq: 0, fresh: true, history: [], historyChars: 0 };
      this.streams.set(streamId, entry);
      this.sendSubscribe(streamId, entry);
    } else {
      // The server only replays to a new socket subscription; catch this listener up locally.
      for (const { seq, chunk } of entry.history)
        this.deliver(listener, chunk, { seq, gap: false });
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

  /** Every action's outcome, wherever in the UI it was sent from. */
  onAction(listener: ActionListener): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  /** Sends an action and resolves with the server's `action.result`. Never rejects. */
  async action(action: UiAction): Promise<RequestResult> {
    const result = await this.request('action', action);
    for (const listener of this.actionListeners) listener(action, result);
    return result;
  }

  /** Keystrokes for a board terminal (F19). Dropped while offline, like an unplugged keyboard. */
  terminalInput(terminalId: string, data: string): void {
    if (!this.synced) return;
    let from = 0;
    while (from < data.length) {
      let to = Math.min(data.length, from + MAX_TERMINAL_INPUT);
      // Never split a surrogate pair across two messages.
      if (to < data.length && /[\uD800-\uDBFF]/.test(data.charAt(to - 1))) to--;
      this.send(
        makeMessage<UiToServer>('terminal.input', { terminalId, data: data.slice(from, to) }),
      );
      from = to;
    }
  }

  /**
   * Whether this tab is visible and focused, and its browser's push subscription: the server skips
   * the push for a device looking at the board. Sent again on every reconnect.
   */
  setPresence(focused: boolean, pushId: string | null): void {
    if (focused === this.presence.focused && pushId === this.presence.pushId) return;
    this.presence = { focused, pushId };
    if (this.synced) this.send(makeMessage<UiToServer>('presence', this.presence));
  }

  /** The size of the xterm showing a board terminal. */
  terminalResize(terminalId: string, cols: number, rows: number): void {
    if (!this.synced) return;
    this.send(makeMessage<UiToServer>('terminal.resize', { terminalId, cols, rows }));
  }

  /**
   * Who asks the user when a board session's folder needs trusting. With one set, a request the
   * server refuses with a trust review waits for the answer: trusted, it is sent again.
   */
  setTrustGate(gate: TrustGate | null): () => void {
    this.trustGate = gate;
    return () => {
      if (this.trustGate === gate) this.trustGate = null;
    };
  }

  async request<T extends RequestMessage['type']>(
    type: T,
    payload: Extract<RequestMessage, { type: T }>['payload'],
  ): Promise<RequestResult> {
    let result = await this.requestOnce(type, payload);
    // A changed folder asks again with what is there now; Cancel keeps the refusal.
    while (!result.ok && result.trust && this.trustGate) {
      const { path, hash } = result.trust;
      if (!(await this.trustGate(result.trust))) return result;
      const trusted = await this.requestOnce('action', { kind: 'folder.trust', path, hash });
      if (!trusted.ok && !trusted.trust) return trusted;
      result = await this.requestOnce(type, payload);
    }
    return result;
  }

  private requestOnce(
    type: RequestMessage['type'],
    payload: RequestMessage['payload'],
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
    const protocols = this.auth?.protocols() ?? [];
    try {
      socket = this.createSocket(this.url, protocols);
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
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.synced = false;
      this.failPending('disconnected');
      if (!this.running) return;
      if ((event as { code?: unknown } | null)?.code === WS_UNAUTHORIZED) {
        // Retrying can't help: wait for a sign-in (`resume`).
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.store.getState().setConnection({ status: 'signedOut', retryAt: null });
        this.auth?.refused(protocols);
        return;
      }
      this.scheduleRetry();
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
      case 'activity':
        this.store.getState().addActivity(message.payload.events, message.payload.replace);
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
        const { ok, error, sessionId, editor, trust } = message.payload;
        pending.resolve(
          ok
            ? {
                ok: true,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(editor !== undefined ? { editor } : {}),
              }
            : { ok: false, error: error ?? 'action_failed', ...(trust ? { trust } : {}) },
        );
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
    // A new socket starts as unfocused without a push id on the server.
    if (firstSync && (this.presence.focused || this.presence.pushId !== null)) {
      this.send(makeMessage<UiToServer>('presence', this.presence));
    }
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
    if (gap) {
      entry.history = [];
      entry.historyChars = 0;
    }
    entry.history.push({ seq, chunk });
    entry.historyChars += chunk.length;
    while (entry.historyChars > STREAM_HISTORY_CHARS && entry.history.length > 1) {
      entry.historyChars -= entry.history.shift()?.chunk.length ?? 0;
    }
    for (const listener of entry.listeners) this.deliver(listener, chunk, { seq, gap });
  }

  private deliver(listener: ChunkListener, chunk: string, info: ChunkInfo): void {
    try {
      listener(chunk, info);
    } catch (error) {
      this.log.warn('stream listener failed', error);
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
