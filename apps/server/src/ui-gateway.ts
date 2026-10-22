import {
  type ApprovalDecision,
  decodeUiToServer,
  encodeServerToUi,
  makeMessage,
  type PatchOp,
  type ServerToUi,
  type StreamId,
  TRANSCRIPT_STREAM_PREFIX,
  type UiToServer,
} from '@c-board/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { type ActionDispatcher, type ActionResult, NOT_IMPLEMENTED } from './actions.js';
import type { ReadResult } from './ring-buffer.js';
import type { BoardStore } from './store.js';

export const UI_WS_PATH = '/ws/ui';
/** PRD §7: patches reach the UI at most 30 times per second. */
export const PATCH_INTERVAL_MS = Math.ceil(1000 / 30);
/** Past this much unsent data a client stops getting live output until it re-subscribes. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Largest UI → server message (characters). */
export const MAX_UI_MESSAGE = 1024 * 1024;

/** Buffered, seq-numbered stream data the gateway replays and forwards. */
export interface StreamSource {
  read(streamId: string, fromSeq?: number): ReadResult | undefined;
  nextSeq(streamId: string): number;
  onData(listener: (streamId: string, seq: number, chunk: string) => void): () => void;
}

export interface UiGatewayOptions {
  store: BoardStore;
  /** Serves `transcript:<sessionId>` streams. */
  transcripts?: StreamSource;
  dispatch: ActionDispatcher;
  /** Handles `approval.decide`. Defaults to `not_implemented`. */
  decideApproval?: (decision: ApprovalDecision) => ActionResult | Promise<ActionResult>;
  logger: FastifyBaseLogger;
  patchIntervalMs?: number;
  maxBufferedBytes?: number;
}

type ServerMessage<T extends ServerToUi['type']> = Extract<ServerToUi, { type: T }>;

interface Client {
  socket: WebSocket;
  /** Live streams; `false` once live data was dropped and a resync marker sent. */
  streams: Map<StreamId, boolean>;
  /** Pending ops that were already part of this client's snapshot. */
  skipOps: number;
}

/**
 * Fans board state and terminal output out to browser clients: a snapshot on
 * connect, throttled patch batches, and replay-then-live output streams.
 */
export class UiGateway {
  private readonly store: BoardStore;
  private readonly transcripts: StreamSource | undefined;
  private readonly dispatch: ActionDispatcher;
  private readonly decideApproval: NonNullable<UiGatewayOptions['decideApproval']>;
  private readonly log: FastifyBaseLogger;
  private readonly patchIntervalMs: number;
  private readonly maxBufferedBytes: number;
  private readonly clients = new Set<Client>();
  private readonly detach: (() => void)[] = [];
  private pending: PatchOp[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastPatchAt = 0;

  constructor(options: UiGatewayOptions) {
    this.store = options.store;
    this.transcripts = options.transcripts;
    this.dispatch = options.dispatch;
    this.decideApproval =
      options.decideApproval ?? (() => ({ ok: false, error: NOT_IMPLEMENTED }) as const);
    this.log = options.logger;
    this.patchIntervalMs = options.patchIntervalMs ?? PATCH_INTERVAL_MS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.detach.push(
      this.store.onPatch((ops) => this.queuePatch(ops)),
      this.store.output.onData((streamId, seq, chunk) => this.onData(streamId, seq, chunk)),
    );
    if (this.transcripts) {
      this.detach.push(
        this.transcripts.onData((streamId, seq, chunk) => this.onData(streamId, seq, chunk)),
      );
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Takes over an accepted socket: sends the snapshot and starts listening. */
  connect(socket: WebSocket): void {
    // Changes made earlier in this tick are already in `state`; collect them now so they
    // reach existing clients but aren't replayed on top of the new client's snapshot.
    this.store.flush();
    const client: Client = { socket, streams: new Map(), skipOps: this.pending.length };
    this.clients.add(client);

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.log.warn('ignored binary ui message');
        return;
      }
      void this.onMessage(client, data.toString());
    });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', (error) => this.log.debug({ err: error }, 'ui socket error'));

    this.send(client, this.message('snapshot', { state: this.store.state }));
  }

  /** Sends a message (toast, approval, …) to every connected client. */
  broadcast(message: ServerToUi): void {
    const data = this.encode(message);
    if (data === undefined) return;
    for (const client of this.clients) this.sendRaw(client, data);
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const off of this.detach.splice(0)) off();
    for (const client of this.clients) client.socket.close(1001, 'server shutting down');
    this.clients.clear();
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    const decoded = decodeUiToServer(raw, { maxLength: MAX_UI_MESSAGE });
    if (!decoded.ok) {
      this.log.warn({ reason: decoded.reason }, 'ignored invalid ui message');
      return;
    }
    const message: UiToServer = decoded.message;
    switch (message.type) {
      case 'subscribe':
        this.subscribe(client, message.payload.streamId, message.payload.fromSeq);
        return;
      case 'unsubscribe':
        client.streams.delete(message.payload.streamId);
        return;
      case 'action': {
        const result = await this.dispatch(message.payload);
        this.reply(client, message.id, result.ok, result.ok ? undefined : result.error);
        return;
      }
      case 'approval.decide': {
        let result: ActionResult;
        try {
          result = await this.decideApproval(message.payload);
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : 'action_failed' };
        }
        this.reply(client, message.id, result.ok, result.ok ? undefined : result.error);
        return;
      }
      case 'session.send':
        // Wired up with the session manager (phase 4+).
        this.reply(client, message.id, false, NOT_IMPLEMENTED);
        return;
    }
  }

  private subscribe(client: Client, streamId: StreamId, fromSeq = 0): void {
    // Replay and go live in one synchronous step, so no chunk falls in between.
    client.streams.set(streamId, true);
    const replay = this.source(streamId)?.read(streamId, fromSeq);
    for (const { seq, chunk } of replay?.chunks ?? []) {
      this.send(client, this.message('stream.data', { streamId, seq, chunk }));
    }
  }

  private onData(streamId: StreamId, seq: number, chunk: string): void {
    let data: string | undefined;
    for (const client of this.clients) {
      if (client.streams.get(streamId) !== true) continue;
      if (client.socket.bufferedAmount > this.maxBufferedBytes) {
        this.dropLive(client, streamId, seq);
        continue;
      }
      data ??= this.encode(this.message('stream.data', { streamId, seq, chunk }));
      if (data !== undefined) this.sendRaw(client, data);
    }
  }

  /** Pauses every live stream of a congested client; it resumes by re-subscribing. */
  private dropLive(client: Client, current: StreamId, seq: number): void {
    for (const [streamId, live] of client.streams) {
      if (!live) continue;
      client.streams.set(streamId, false);
      const fromSeq = streamId === current ? seq : (this.source(streamId)?.nextSeq(streamId) ?? 0);
      this.send(client, this.message('stream.resync', { streamId, fromSeq }));
    }
    this.log.warn({ bufferedAmount: client.socket.bufferedAmount }, 'ui client fell behind');
  }

  private source(streamId: StreamId): StreamSource | undefined {
    if (streamId.startsWith(TRANSCRIPT_STREAM_PREFIX)) return this.transcripts;
    return this.store.output;
  }

  private queuePatch(ops: PatchOp[]): void {
    if (this.clients.size === 0) return;
    this.pending.push(...ops);
    if (this.timer) return;
    const wait = Math.max(0, this.lastPatchAt + this.patchIntervalMs - Date.now());
    this.timer = setTimeout(() => this.flushPatches(), wait);
  }

  private flushPatches(): void {
    this.timer = undefined;
    this.lastPatchAt = Date.now();
    const ops = this.pending;
    this.pending = [];
    let full: string | undefined;
    for (const client of this.clients) {
      const skip = client.skipOps;
      client.skipOps = 0;
      if (skip >= ops.length) continue;
      if (skip > 0) {
        this.send(client, this.message('patch', { ops: ops.slice(skip) }));
        continue;
      }
      full ??= this.encode(this.message('patch', { ops }));
      if (full !== undefined) this.sendRaw(client, full);
    }
  }

  private reply(client: Client, id: string | undefined, ok: boolean, error?: string): void {
    if (id === undefined) return;
    const payload = error === undefined ? { id, ok } : { id, ok, error: error.slice(0, 1_000) };
    this.send(client, this.message('action.result', payload));
  }

  private message<T extends ServerToUi['type']>(
    type: T,
    payload: ServerMessage<T>['payload'],
  ): ServerMessage<T> {
    return makeMessage<ServerMessage<T>>(type as ServerMessage<T>['type'], payload);
  }

  private encode(message: ServerToUi): string | undefined {
    const encoded = encodeServerToUi(message);
    if (encoded.ok) return encoded.data;
    this.log.error({ type: message.type, reason: encoded.reason }, 'dropped invalid ui message');
    return undefined;
  }

  private send(client: Client, message: ServerToUi): void {
    const data = this.encode(message);
    if (data !== undefined) this.sendRaw(client, data);
  }

  private sendRaw(client: Client, data: string): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(data);
  }
}

/**
 * `/ws/ui`. Only the board's own origin (or a configured dev origin) with a valid
 * session gets through: the security layer rejects foreign origins, and here an
 * absent Origin is refused too, since browsers always send one on WebSocket upgrades.
 */
export function registerUiGateway(app: FastifyInstance, gateway: UiGateway): void {
  app.get(
    UI_WS_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (request.headers.origin === undefined) {
          return reply.code(403).send({ error: 'forbidden_origin' });
        }
        if (!request.isAuthorized()) return reply.code(401).send({ error: 'unauthorized' });
      },
    },
    (socket) => gateway.connect(socket),
  );
  app.addHook('preClose', async () => gateway.close());
}

declare module 'fastify' {
  interface FastifyInstance {
    uiGateway: UiGateway;
  }
}
