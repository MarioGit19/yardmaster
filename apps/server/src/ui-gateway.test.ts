import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  type ActivityEvent,
  applyPatch,
  emptyBoardState,
  HISTORY_WINDOW_MS,
  type PatchOp,
  SESSION_HEADER,
  SESSION_PROTOCOL_PREFIX,
  type ServerToUi,
  UI_WS_PROTOCOL,
  WS_UNAUTHORIZED,
} from '@yardmaster/protocol';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type ActionHandlers, createActionDispatcher, stubActionHandlers } from './actions.js';
import { startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { RingBuffer } from './ring-buffer.js';
import { TOKEN_HEADER } from './security.js';
import { sessionHeader } from './sessions.test-helpers.js';
import { BoardStore, commandHeader } from './store.js';
import { generateToken } from './token.js';
import { UI_WS_PATH, UiGateway } from './ui-gateway.js';

const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  home: '/home/dev/.yardmaster',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const silent = pino({ level: 'silent' }) as FastifyBaseLogger;

const project = {
  id: 'a1b2c3d4e5f6',
  path: '/home/dev/acme-shop',
  name: 'acme-shop',
  accent: 3,
  source: 'editor' as const,
  git: null,
  createdAt: 1_700_000_000_000,
  lastActivityAt: null,
};

let app: FastifyInstance | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
});

async function boot(actions?: ActionHandlers): Promise<{ port: number; origin: string }> {
  app = await startServer(config, { token, dbPath: ':memory:', actions, processes: false });
  const { port } = app.server.address() as AddressInfo;
  return { port, origin: `http://127.0.0.1:${port}` };
}

/** A ws client that queues every server message for `next()`. */
class Client {
  readonly socket: WebSocket;
  private readonly queue: ServerToUi[] = [];
  private readonly waiters: ((message: ServerToUi) => void)[] = [];

  constructor(port: number, headers: Record<string, string>) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, { headers });
    sockets.push(this.socket);
    this.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerToUi;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  next(): Promise<ServerToUi> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 2_000);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async nextOf<T extends ServerToUi['type']>(type: T): Promise<Extract<ServerToUi, { type: T }>> {
    for (;;) {
      const message = await this.next();
      if (message.type === type) return message as Extract<ServerToUi, { type: T }>;
    }
  }

  send(type: string, payload: unknown, id?: string): void {
    this.socket.send(JSON.stringify({ v: 1, type, ts: Date.now(), payload, id }));
  }
}

async function connect(port: number, origin: string): Promise<Client> {
  const client = new Client(port, { origin, ...sessionHeader(app as FastifyInstance) });
  await client.opened();
  return client;
}

function rejection(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, { headers });
    sockets.push(socket);
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('open', () => reject(new Error('connection was accepted')));
    socket.on('error', () => {});
  });
}

/** Opens a socket and resolves with its close code; it must close before any message. */
function closeCode(
  port: number,
  headers: Record<string, string>,
  protocols: string[] = [],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, protocols, { headers });
    sockets.push(socket);
    socket.on('unexpected-response', (_req, res) =>
      reject(new Error(`refused with HTTP ${res.statusCode}`)),
    );
    socket.on('message', () => reject(new Error('a signed-out socket got a message')));
    socket.on('close', (code) => resolve(code));
    socket.on('error', () => {});
  });
}

function seedTerminal(store: BoardStore): void {
  store.upsertTerminal({ id: 'term-1', windowId: 'win-1', name: 'dev', projectId: project.id });
  store.startExec({
    execId: 'exec-1',
    terminalId: 'term-1',
    commandLine: 'pnpm dev',
    confidence: 'high',
    cwd: project.path,
  });
}

describe('/ws/ui connection', () => {
  it('sends the current state as a snapshot on connect', async () => {
    const { port, origin } = await boot();
    app?.store.upsertProject(project);
    const client = await connect(port, origin);
    const snapshot = await client.nextOf('snapshot');
    expect(snapshot.payload.state.projects[project.id]).toEqual(project);
  });

  it('rejects a foreign origin', async () => {
    const { port } = await boot();
    const session = sessionHeader(app as FastifyInstance);
    expect(await rejection(port, { origin: 'http://evil.example', ...session })).toBe(403);
  });

  it('rejects a missing origin even with the token', async () => {
    const { port } = await boot();
    expect(await rejection(port, { [TOKEN_HEADER]: token })).toBe(403);
  });

  it('closes a socket without a valid session with 4401, before sending anything', async () => {
    const { port, origin } = await boot();
    expect(await closeCode(port, { origin })).toBe(WS_UNAUTHORIZED);
    const forged = `${generateToken().slice(0, 16)}.${generateToken()}`;
    expect(await closeCode(port, { origin, [SESSION_HEADER]: forged })).toBe(WS_UNAUTHORIZED);
    // A browser holding an old session cookie (and the cookies of other ports) gets nothing.
    expect(
      await closeCode(port, { origin, cookie: `yardmaster_session=x.y; cboard_session=x.y` }),
    ).toBe(WS_UNAUTHORIZED);
  });

  it('takes the session as a subprotocol and answers with the board protocol only', async () => {
    const { port, origin } = await boot();
    const secret = sessionHeader(app as FastifyInstance)[SESSION_HEADER] as string;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${UI_WS_PATH}`,
      [UI_WS_PROTOCOL, `${SESSION_PROTOCOL_PREFIX}${secret}`],
      { headers: { origin } },
    );
    sockets.push(socket);
    const first = await new Promise<ServerToUi>((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString()) as ServerToUi));
      socket.once('close', (code) => reject(new Error(`closed with ${code}`)));
    });
    expect(first.type).toBe('snapshot');
    expect(socket.protocol).toBe(UI_WS_PROTOCOL);
  });

  it('rejects a foreign Host header', async () => {
    const { port, origin } = await boot();
    const session = sessionHeader(app as FastifyInstance);
    expect(await rejection(port, { origin, ...session, host: `rebind.example:${port}` })).toBe(403);
  });
});

describe('/ws/ui patches', () => {
  it('streams coalesced patches that turn the snapshot into the current state', async () => {
    const { port, origin } = await boot();
    const store = app?.store as BoardStore;
    const client = await connect(port, origin);
    let state = (await client.nextOf('snapshot')).payload.state;

    store.upsertProject(project);
    await Promise.resolve();
    store.touchProject(project.id, 1_700_000_001_000);
    await Promise.resolve();
    seedTerminal(store);

    const ops: PatchOp[] = [];
    while (JSON.stringify(state) !== JSON.stringify(store.state)) {
      const patch = await client.nextOf('patch');
      ops.push(...patch.payload.ops);
      state = applyPatch(state, patch.payload.ops);
    }
    expect(state).toEqual(store.state);
    expect(ops.length).toBeGreaterThan(0);
  });

  it('limits patch batches to 30 per second', async () => {
    const { port, origin } = await boot();
    const store = app?.store as BoardStore;
    const client = await connect(port, origin);
    await client.nextOf('snapshot');
    const stamps: number[] = [];
    client.socket.on('message', (data) => {
      if ((JSON.parse(data.toString()) as ServerToUi).type === 'patch') stamps.push(Date.now());
    });

    store.upsertProject(project);
    for (let i = 1; i <= 20; i++) {
      store.touchProject(project.id, project.createdAt + i);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    // ~20 changes over ≥ 100 ms collapse into a few batches spaced ≥ 1/30 s apart.
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps.length).toBeLessThan(20);
    for (let i = 1; i < stamps.length; i++) {
      expect((stamps[i] as number) - (stamps[i - 1] as number)).toBeGreaterThanOrEqual(30);
    }
  });

  it("doesn't replay changes that the new client's snapshot already holds", async () => {
    const { port, origin } = await boot();
    const store = app?.store as BoardStore;
    const first = await connect(port, origin);
    await first.nextOf('snapshot');

    store.upsertProject(project);
    const second = await connect(port, origin);
    const snapshot = await second.nextOf('snapshot');
    expect(snapshot.payload.state.projects[project.id]).toEqual(project);
    expect((await first.nextOf('patch')).payload.ops).toHaveLength(1);

    store.removeProject(project.id);
    const patch = await second.nextOf('patch');
    expect(patch.payload.ops).toEqual([{ op: 'delete', path: ['projects', project.id] }]);
  });
});

describe('/ws/ui activity', () => {
  const event = (id: string, ts: number): ActivityEvent => ({
    id,
    ts,
    kind: 'exec.end',
    projectId: project.id,
    sessionId: null,
    terminalId: 'term-1',
    execId: 'exec-1',
    summary: 'pnpm test',
    data: { exitCode: 1 },
  });

  it('replays the history window after the snapshot, then pushes live batches', async () => {
    const { port, origin } = await boot();
    const now = Date.now();
    app?.persistence.recordActivity(event('old', now - HISTORY_WINDOW_MS - 60_000));
    app?.persistence.recordActivity(event('recent', now - 60_000));
    const client = await connect(port, origin);
    expect((await client.next()).type).toBe('snapshot');
    const replay = await client.next();
    expect(replay.type).toBe('activity');
    expect(replay.payload).toEqual({ events: [event('recent', now - 60_000)], replace: true });

    app?.uiGateway.pushActivity(event('live-1', now));
    app?.uiGateway.pushActivity(event('live-2', now + 1));
    const live = await client.nextOf('activity');
    expect(live.payload.replace).toBe(false);
    expect(live.payload.events.map((e) => e.id)).toEqual(['live-1', 'live-2']);
  });
});

describe('/ws/ui streams', () => {
  it('replays the buffer from fromSeq, then streams live data', async () => {
    const { port, origin } = await boot();
    const store = app?.store as BoardStore;
    seedTerminal(store);
    for (const line of ['one\n', 'two\n', 'three\n']) store.appendExecOutput('exec-1', line);

    const client = await connect(port, origin);
    await client.nextOf('snapshot');
    client.send('subscribe', { streamId: 'exec:exec-1', fromSeq: 1 });
    expect((await client.nextOf('stream.data')).payload).toEqual({
      streamId: 'exec:exec-1',
      seq: 1,
      chunk: 'two\n',
    });
    expect((await client.nextOf('stream.data')).payload.seq).toBe(2);

    store.appendExecOutput('exec-1', '\x1b[32mready\x1b[0m\n');
    expect((await client.nextOf('stream.data')).payload).toEqual({
      streamId: 'exec:exec-1',
      seq: 3,
      chunk: '\x1b[32mready\x1b[0m\n',
    });
  });

  it('streams a terminal subscribed before it has output, and stops after unsubscribe', async () => {
    const { port, origin } = await boot();
    const store = app?.store as BoardStore;
    seedTerminal(store);
    const client = await connect(port, origin);
    await client.nextOf('snapshot');

    client.send('subscribe', { streamId: 'term:term-1' });
    client.send('subscribe', { streamId: 'exec:other' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The replay: the run's command line.
    const header = await client.nextOf('stream.data');
    expect(header.payload).toEqual({
      streamId: 'term:term-1',
      seq: 0,
      chunk: `${commandHeader('pnpm dev')}\r\n`,
    });
    store.appendExecOutput('exec-1', 'hello\n');
    const data = await client.nextOf('stream.data');
    expect(data.payload).toEqual({ streamId: 'term:term-1', seq: 1, chunk: 'hello\n' });

    client.send('unsubscribe', { streamId: 'term:term-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.appendExecOutput('exec-1', 'bye\n');
    store.upsertProject(project);
    // The project patch arrives; no stream data came before it.
    expect((await client.next()).type).toBe('patch');
  });
});

const REVIEW = {
  path: '/home/dev/cloned-tool',
  hash: 'c'.repeat(64),
  findings: [
    {
      file: '.claude/settings.json' as const,
      kind: 'hook' as const,
      label: 'SessionStart hook',
      detail: './setup.sh',
    },
  ],
  truncated: false,
};

describe('/ws/ui messages', () => {
  it('routes actions to the dispatcher and replies when the message has an id', async () => {
    const seen: string[] = [];
    const actions: ActionHandlers = {
      ...stubActionHandlers(),
      'terminal.focus': (action) => {
        seen.push(action.terminalId);
        return { ok: true };
      },
      // The session an action started travels back with the result.
      'session.close': () => ({ ok: true, sessionId: 'sess-2' }),
      // So does the review of a folder a board session can't start in yet.
      'session.create': () => ({ ok: false, error: 'folder_untrusted', trust: REVIEW }),
    };
    const { port, origin } = await boot(actions);
    const client = await connect(port, origin);
    await client.nextOf('snapshot');

    client.send('action', { kind: 'terminal.focus', terminalId: 'term-1' }, 'act-1');
    expect((await client.nextOf('action.result')).payload).toEqual({ id: 'act-1', ok: true });
    expect(seen).toEqual(['term-1']);

    client.send('action', { kind: 'session.close', sessionId: 'sess-1' }, 'act-3');
    expect((await client.nextOf('action.result')).payload).toEqual({
      id: 'act-3',
      ok: true,
      sessionId: 'sess-2',
    });

    client.send('action', { kind: 'session.create', projectId: 'p1', prompt: 'hi' }, 'act-4');
    expect((await client.nextOf('action.result')).payload).toEqual({
      id: 'act-4',
      ok: false,
      error: 'folder_untrusted',
      trust: REVIEW,
    });

    client.send('action', { kind: 'terminal.interrupt', terminalId: 'term-1' }, 'act-2');
    expect((await client.nextOf('action.result')).payload).toEqual({
      id: 'act-2',
      ok: false,
      error: 'not_implemented',
    });
  });

  it('ignores invalid messages and keeps the connection open', async () => {
    const { port, origin } = await boot();
    const client = await connect(port, origin);
    await client.nextOf('snapshot');

    client.socket.send('not json');
    client.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    client.send('action', { kind: 'project.explode' }, 'bad-1');
    client.send('subscribe', { streamId: 'nope' });
    client.send('approval.decide', { approvalId: 'appr-1', decision: 'allow' }, 'ap-1');

    expect((await client.nextOf('action.result')).payload).toEqual({
      id: 'ap-1',
      ok: false,
      // Routed to the session runner, which holds no such approval.
      error: 'unknown_approval',
    });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('/ws/ui presence', () => {
  it('tracks which push subscriptions have a focused tab, until the socket closes', async () => {
    const { port, origin } = await boot();
    const gateway = (app as FastifyInstance).uiGateway;
    const phone = await connect(port, origin);
    const mac = await connect(port, origin);
    phone.send('presence', { focused: true, pushId: 'push-phone' });
    mac.send('presence', { focused: false, pushId: 'push-mac' });
    await expect.poll(() => [...gateway.focusedPushIds()]).toEqual(['push-phone']);
    phone.socket.close();
    await expect.poll(() => gateway.focusedPushIds().size).toBe(0);
  });
});

describe('/ws/ui session.send', () => {
  it('routes to the session runner', async () => {
    const { port, origin } = await boot();
    const client = await connect(port, origin);
    await client.nextOf('snapshot');

    client.send('session.send', { sessionId: 'sess-unknown', text: 'hello' }, 'send-1');
    expect((await client.nextOf('action.result')).payload).toEqual({
      id: 'send-1',
      ok: false,
      error: 'session_not_running',
    });
  });
});

describe('action dispatcher', () => {
  it('turns handler errors into a failed result', async () => {
    const dispatch = createActionDispatcher({
      ...stubActionHandlers(),
      'project.add': () => {
        throw new Error('path is not a directory');
      },
    });
    expect(await dispatch({ kind: 'project.add', path: '/home/dev/missing' })).toEqual({
      ok: false,
      error: 'path is not a directory',
    });
  });
});

/** Stand-in socket whose `bufferedAmount` the test controls. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: ServerToUi[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerToUi);
  }

  close(): void {
    this.readyState = 3;
  }

  take(): ServerToUi[] {
    return this.sent.splice(0);
  }

  receive(type: string, payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ v: 1, type, ts: 1, payload })), false);
  }
}

describe('UiGateway backpressure', () => {
  function setup() {
    const store = new BoardStore({ autoFlush: false });
    const gateway = new UiGateway({
      store,
      dispatch: createActionDispatcher(stubActionHandlers()),
      logger: silent,
      maxBufferedBytes: 1_000,
    });
    seedTerminal(store);
    const socket = new FakeSocket();
    gateway.connect(socket as never);
    return { store, gateway, socket };
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('drops live data for a congested client and sends a resync marker per stream', async () => {
    const { store, gateway, socket } = setup();
    socket.receive('subscribe', { streamId: 'exec:exec-1' });
    socket.receive('subscribe', { streamId: 'term:term-1' });
    await settle();
    store.appendExecOutput('exec-1', 'a\n');
    socket.take();

    socket.bufferedAmount = 5_000;
    store.appendExecOutput('exec-1', 'b\n');
    store.appendExecOutput('exec-1', 'c\n');
    expect(socket.take()).toEqual([
      expect.objectContaining({
        type: 'stream.resync',
        payload: { streamId: 'exec:exec-1', fromSeq: 1 },
      }),
      expect.objectContaining({
        type: 'stream.resync',
        payload: { streamId: 'term:term-1', fromSeq: 2 },
      }),
    ]);

    // Re-subscribing after the backlog drains replays what was dropped, then goes live.
    socket.bufferedAmount = 0;
    socket.receive('subscribe', { streamId: 'exec:exec-1', fromSeq: 1 });
    await settle();
    store.appendExecOutput('exec-1', 'd\n');
    const data = socket.take().filter((m) => m.type === 'stream.data');
    expect(
      data.map((m) => (m.type === 'stream.data' ? [m.payload.seq, m.payload.chunk] : [])),
    ).toEqual([
      [1, 'b\n'],
      [2, 'c\n'],
      [3, 'd\n'],
    ]);
    gateway.close();
  });

  it('keeps sending patches to a congested client', async () => {
    const { store, gateway, socket } = setup();
    socket.take();
    socket.bufferedAmount = 5_000;
    store.upsertProject(project);
    store.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const patches = socket.take().filter((m) => m.type === 'patch');
    expect(patches).toHaveLength(1);
    let state = emptyBoardState();
    for (const patch of patches)
      if (patch.type === 'patch') state = applyPatch(state, patch.payload.ops);
    expect(state.projects[project.id]).toEqual(project);
    gateway.close();
  });

  it('stops listening to the store once closed', () => {
    const { store, gateway, socket } = setup();
    gateway.close();
    socket.take();
    socket.readyState = 1;
    store.appendExecOutput('exec-1', 'late\n');
    store.flush();
    expect(socket.take()).toEqual([]);
    expect(gateway.clientCount).toBe(0);
  });
});

describe('UiGateway transcript streams', () => {
  it('replays and forwards transcript:<sessionId> streams from the transcript source', async () => {
    const store = new BoardStore({ autoFlush: false });
    const ring = new RingBuffer(1_000);
    const listeners = new Set<(streamId: string, seq: number, chunk: string) => void>();
    const transcripts = {
      read: (streamId: string, fromSeq?: number) =>
        streamId === 'transcript:s-1' ? ring.read(fromSeq) : undefined,
      nextSeq: () => ring.nextSeq,
      onData: (listener: (streamId: string, seq: number, chunk: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const push = (chunk: string) => {
      const seq = ring.append(chunk);
      for (const listener of listeners) listener('transcript:s-1', seq, chunk);
    };
    const gateway = new UiGateway({
      store,
      transcripts,
      dispatch: createActionDispatcher(stubActionHandlers()),
      logger: silent,
    });
    const socket = new FakeSocket();
    gateway.connect(socket as never);
    push('{"kind":"user"}');
    socket.take();

    socket.receive('subscribe', { streamId: 'transcript:s-1' });
    await new Promise((resolve) => setImmediate(resolve));
    push('{"kind":"assistant"}');
    expect(
      socket
        .take()
        .map((m) => (m.type === 'stream.data' ? [m.payload.streamId, m.payload.seq] : m.type)),
    ).toEqual([
      ['transcript:s-1', 0],
      ['transcript:s-1', 1],
    ]);

    gateway.close();
    push('{"kind":"late"}');
    expect(listeners.size).toBe(0);
  });
});
