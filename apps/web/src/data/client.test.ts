import {
  type BoardState,
  decodeUiToServer,
  emptyBoardState,
  makeMessage,
  type Project,
  type ServerToUi,
  type Terminal,
  type UiToServer,
} from '@c-board/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoardClient,
  backoffDelay,
  type ChunkInfo,
  MAX_TERMINAL_INPUT,
  type SocketLike,
  STREAM_HISTORY_CHARS,
} from './client.js';
import { selectProjects, selectTerminalsByProject } from './selectors.js';
import { createBoardStore } from './store.js';

// Synthetic sample data only.
const T0 = 1_760_000_000_000;

const project = (id: string, name: string): Project => ({
  id,
  path: `/home/dev/${name}`,
  name,
  accent: 2,
  source: 'editor',
  git: null,
  createdAt: T0,
  lastActivityAt: null,
});

const terminal = (id: string, projectId: string | null): Terminal => ({
  id,
  windowId: 'win-1',
  projectId,
  name: 'zsh',
  shellPid: 4242,
  cwd: '/home/dev/acme-shop',
  state: 'open',
  shellIntegration: true,
  active: false,
  exitCode: null,
  executionIds: [],
  stats: null,
  createdAt: T0,
  closedAt: null,
});

function board(partial: Partial<BoardState> = {}): BoardState {
  return { ...emptyBoardState(), ...partial };
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly sent: UiToServer[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    const decoded = decodeUiToServer(data);
    if (!decoded.ok) throw new Error(`client sent an invalid message: ${decoded.reason}`);
    this.sent.push(decoded.message);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // Server side of the fake.
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: ServerToUi | string): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  snapshot(state: BoardState): void {
    this.receive(makeMessage<ServerToUi>('snapshot', { state }));
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  subscribes() {
    return this.sent.flatMap((m) => (m.type === 'subscribe' ? [m.payload] : []));
  }
}

function setup(options: { requestTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const store = createBoardStore();
  const logger = { warn: vi.fn() };
  const client = new BoardClient({
    url: 'ws://127.0.0.1:4317/ws/ui',
    store,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0,
    logger,
    ...options,
  });
  const last = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error('no socket yet');
    return socket;
  };
  /** Opens the newest socket and sends it a snapshot. */
  const connect = (state: BoardState = board()) => {
    const socket = last();
    socket.open();
    socket.snapshot(state);
    return socket;
  };
  return { sockets, store, client, logger, last, connect };
}

const data = (streamId: string, seq: number, chunk: string) =>
  makeMessage<ServerToUi>('stream.data', { streamId, seq, chunk });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backoffDelay', () => {
  it('doubles from the base and caps at 10 s', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 10].map((n) => backoffDelay(n, 500, 10_000, () => 0));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it('takes at most 20% off as jitter', () => {
    expect(backoffDelay(3, 500, 10_000, () => 0.5)).toBe(1800);
    expect(backoffDelay(9, 500, 10_000, () => 0.999)).toBeGreaterThanOrEqual(8000);
  });
});

describe('BoardClient sync', () => {
  it('goes connecting → syncing → live and applies the snapshot', () => {
    const { client, store, last } = setup();
    client.start();
    expect(store.getState().connection.status).toBe('connecting');
    expect(last().url).toBe('ws://127.0.0.1:4317/ws/ui');

    last().open();
    expect(store.getState().connection.status).toBe('syncing');
    expect(store.getState().hydrated).toBe(false);

    last().snapshot(board({ projects: { p1: project('p1', 'acme-shop') } }));
    const state = store.getState();
    expect(state.connection).toMatchObject({ status: 'live', attempt: 0, syncedAt: T0 });
    expect(state.hydrated).toBe(true);
    expect(selectProjects(state).map((p) => p.name)).toEqual(['acme-shop']);
  });

  it('applies patches in order and keeps untouched entities identical', () => {
    const { client, store, connect, last } = setup();
    client.start();
    connect(
      board({
        projects: { p1: project('p1', 'acme-shop'), p2: project('p2', 'zeta-api') },
        terminals: { t1: terminal('t1', 'p1') },
      }),
    );
    const before = store.getState().board;

    last().receive(
      makeMessage<ServerToUi>('patch', {
        ops: [
          { op: 'set', path: ['terminals', 't2'], value: terminal('t2', 'p1') },
          { op: 'merge', path: ['projects', 'p2'], value: { name: 'beta-api' } },
          { op: 'delete', path: ['terminals', 't1'] },
        ],
      }),
    );
    const after = store.getState().board;
    expect(Object.keys(after.terminals)).toEqual(['t2']);
    expect(after.projects.p2?.name).toBe('beta-api');
    expect(after.projects.p1).toBe(before.projects.p1);
    expect(selectProjects(store.getState()).map((p) => p.name)).toEqual(['acme-shop', 'beta-api']);
    expect(selectTerminalsByProject('p1')(store.getState()).map((t) => t.id)).toEqual(['t2']);
  });

  it('ignores patches before the snapshot and invalid messages', () => {
    const { client, store, last, logger } = setup();
    client.start();
    last().open();
    last().receive(
      makeMessage<ServerToUi>('patch', {
        ops: [{ op: 'set', path: ['projects', 'p1'], value: project('p1', 'acme-shop') }],
      }),
    );
    expect(store.getState().board.projects).toEqual({});

    last().snapshot(board());
    last().receive('{not json');
    last().receive(JSON.stringify({ v: 1, type: 'patch', ts: T0, payload: { ops: 'nope' } }));
    last().receive(
      JSON.stringify({ v: 1, type: 'snapshot', ts: T0, payload: { state: { projects: 1 } } }),
    );
    expect(store.getState().board).toEqual(board());
    expect(store.getState().connection.status).toBe('live');
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });

  it('forwards toasts and approvals to message listeners', () => {
    const { client, connect, last } = setup();
    const listener = vi.fn();
    client.onMessage(listener);
    client.start();
    connect();
    last().receive(makeMessage<ServerToUi>('toast', { level: 'info', title: 'Build finished' }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'toast' }));
  });
});

describe('BoardClient reconnect', () => {
  it('backs off exponentially up to 10 s while the server is down', () => {
    const { client, store, sockets, last } = setup();
    client.start();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      last().drop();
      const { retryAt, status, attempt } = store.getState().connection;
      expect(status).toBe('reconnecting');
      expect(attempt).toBe(i + 1);
      const wait = (retryAt ?? 0) - Date.now();
      waits.push(wait);
      const count = sockets.length;
      vi.advanceTimersByTime(wait - 1);
      expect(sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(count + 1);
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it('resets the backoff only once a snapshot arrives', () => {
    const { client, store, last } = setup();
    client.start();
    last().drop();
    vi.advanceTimersByTime(500);
    last().open();
    last().drop(); // open but closed before syncing: still backing off
    expect(store.getState().connection.attempt).toBe(2);
    vi.advanceTimersByTime(1000);
    last().open();
    last().snapshot(board());
    expect(store.getState().connection).toMatchObject({ status: 'live', attempt: 0 });

    last().drop();
    expect((store.getState().connection.retryAt ?? 0) - Date.now()).toBe(500);
  });

  it('resyncs from the new snapshot after a reconnect', () => {
    const { client, store, connect, last } = setup();
    client.start();
    connect(
      board({
        projects: { p1: project('p1', 'acme-shop') },
        terminals: { t1: terminal('t1', 'p1') },
      }),
    );
    last().drop();
    // The board keeps showing the last known state while offline.
    expect(store.getState().board.terminals.t1).toBeDefined();
    expect(store.getState().hydrated).toBe(true);

    vi.advanceTimersByTime(500);
    connect(board({ projects: { p1: project('p1', 'acme-shop'), p3: project('p3', 'orbit') } }));
    const state = store.getState().board;
    expect(state.terminals).toEqual({});
    expect(Object.keys(state.projects).sort()).toEqual(['p1', 'p3']);

    last().receive(
      makeMessage<ServerToUi>('patch', { ops: [{ op: 'delete', path: ['projects', 'p3'] }] }),
    );
    expect(Object.keys(store.getState().board.projects)).toEqual(['p1']);
  });

  it('ignores a stale socket after a reconnect', () => {
    const { client, store, connect, sockets } = setup();
    client.start();
    const first = connect();
    first.drop();
    vi.advanceTimersByTime(500);
    connect(board({ projects: { p1: project('p1', 'acme-shop') } }));
    first.snapshot(board());
    first.drop();
    expect(sockets).toHaveLength(2);
    expect(store.getState().connection.status).toBe('live');
    expect(store.getState().board.projects.p1).toBeDefined();
  });

  it('reconnects immediately on reconnectNow and stops for good on stop', () => {
    const { client, store, sockets, last } = setup();
    client.start();
    last().drop();
    vi.advanceTimersByTime(100);
    client.reconnectNow();
    expect(sockets).toHaveLength(2);

    client.stop();
    expect(last().closed).toBe(true);
    expect(store.getState().connection.status).toBe('stopped');
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it('retries when the socket cannot be created', () => {
    const store = createBoardStore();
    let calls = 0;
    const client = new BoardClient({
      url: 'ws://127.0.0.1:4317/ws/ui',
      store,
      random: () => 0,
      logger: { warn: () => {} },
      createSocket: (url) => {
        calls++;
        if (calls === 1) throw new Error('blocked');
        return new FakeSocket(url);
      },
    });
    client.start();
    expect(store.getState().connection.status).toBe('reconnecting');
    vi.advanceTimersByTime(500);
    expect(calls).toBe(2);
  });
});

describe('BoardClient presence', () => {
  const presences = (socket: FakeSocket) =>
    socket.sent.flatMap((m) => (m.type === 'presence' ? [m.payload] : []));

  it('reports focus and the push id once synced, on change, and again after a reconnect', () => {
    const { client, connect, last } = setup();
    client.start();
    client.setPresence(true, 'push-1');
    expect(last().sent).toEqual([]);
    const first = connect();
    expect(presences(first)).toEqual([{ focused: true, pushId: 'push-1' }]);

    client.setPresence(true, 'push-1');
    client.setPresence(false, 'push-1');
    expect(presences(first)).toEqual([
      { focused: true, pushId: 'push-1' },
      { focused: false, pushId: 'push-1' },
    ]);

    first.drop();
    vi.advanceTimersByTime(500);
    expect(presences(connect())).toEqual([{ focused: false, pushId: 'push-1' }]);
  });
});

describe('BoardClient streams', () => {
  const S = 'exec:e1';

  it('subscribes after the snapshot and delivers chunks in order', () => {
    const { client, last } = setup();
    const chunks: [string, ChunkInfo][] = [];
    client.start();
    client.subscribeStream(S, (chunk, info) => chunks.push([chunk, info]));
    last().open();
    expect(last().subscribes()).toEqual([]);
    last().snapshot(board());
    expect(last().subscribes()).toEqual([{ streamId: S }]);

    last().receive(data(S, 0, 'a'));
    last().receive(data(S, 1, 'b'));
    last().receive(data('exec:other', 2, 'x'));
    expect(chunks).toEqual([
      ['a', { seq: 0, gap: false }],
      ['b', { seq: 1, gap: false }],
    ]);
  });

  it('resumes from the next seq after a reconnect without duplicates', () => {
    const { client, connect, last } = setup();
    const received: string[] = [];
    client.start();
    connect();
    client.subscribeStream(S, (chunk) => received.push(chunk));
    expect(last().subscribes()).toEqual([{ streamId: S }]);
    last().receive(data(S, 0, 'a'));
    last().receive(data(S, 1, 'b'));

    last().drop();
    vi.advanceTimersByTime(500);
    const socket = connect();
    expect(socket.subscribes()).toEqual([{ streamId: S, fromSeq: 2 }]);
    // A replay overlapping what we have is deduplicated.
    socket.receive(data(S, 1, 'b'));
    socket.receive(data(S, 2, 'c'));
    expect(received).toEqual(['a', 'b', 'c']);
  });

  it('re-subscribes on stream.resync and flags lost output as a gap', () => {
    const { client, connect, last } = setup();
    const infos: ChunkInfo[] = [];
    client.start();
    connect();
    client.subscribeStream(S, (_chunk, info) => infos.push(info));
    last().receive(data(S, 0, 'a'));
    last().receive(makeMessage<ServerToUi>('stream.resync', { streamId: S, fromSeq: 1 }));
    expect(last().subscribes()).toEqual([{ streamId: S }, { streamId: S, fromSeq: 1 }]);

    // The buffer wrapped meanwhile: replay starts at 5.
    last().receive(data(S, 5, 'f'));
    last().receive(data(S, 6, 'g'));
    expect(infos).toEqual([
      { seq: 0, gap: false },
      { seq: 5, gap: true },
      { seq: 6, gap: false },
    ]);
  });

  it('does not flag a gap on the first chunk of a fresh subscription', () => {
    const { client, connect, last } = setup();
    const infos: ChunkInfo[] = [];
    client.start();
    connect();
    client.subscribeStream(S, (_chunk, info) => infos.push(info));
    last().receive(data(S, 40, 'late'));
    expect(infos).toEqual([{ seq: 40, gap: false }]);
  });

  it('catches a late listener up from recent history, starting after the last gap', () => {
    const { client, connect, last } = setup();
    client.start();
    connect();
    const stop = client.subscribeStream(S, () => {});
    last().receive(data(S, 0, 'a'));
    last().receive(data(S, 1, 'b'));

    const late: [string, ChunkInfo][] = [];
    client.subscribeStream(S, (chunk, info) => late.push([chunk, info]));
    expect(late).toEqual([
      ['a', { seq: 0, gap: false }],
      ['b', { seq: 1, gap: false }],
    ]);
    last().receive(data(S, 2, 'c'));
    expect(late.map(([chunk]) => chunk)).toEqual(['a', 'b', 'c']);
    // Only one server subscription, so no second replay arrives.
    expect(last().subscribes()).toEqual([{ streamId: S }]);

    // Output lost to a gap isn't papered over for the next listener.
    last().receive(data(S, 9, 'j'));
    const later: string[] = [];
    client.subscribeStream(S, (chunk) => later.push(chunk));
    expect(later).toEqual(['j']);
    stop();
  });

  it('keeps a bounded history', () => {
    const { client, connect, last } = setup();
    client.start();
    connect();
    client.subscribeStream(S, () => {});
    const big = 'x'.repeat(STREAM_HISTORY_CHARS / 2);
    for (let seq = 0; seq < 4; seq++) last().receive(data(S, seq, big));
    const seqs: number[] = [];
    client.subscribeStream(S, (_chunk, info) => seqs.push(info.seq));
    expect(seqs).toEqual([2, 3]);
  });

  it('shares one server subscription between listeners and unsubscribes after the last', () => {
    const { client, connect, last, logger } = setup();
    client.start();
    connect();
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error('boom');
    });
    const offA = client.subscribeStream(S, a);
    const offB = client.subscribeStream(S, b);
    expect(last().subscribes()).toHaveLength(1);

    last().receive(data(S, 0, 'x'));
    expect(a).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('stream listener failed', expect.any(Error));

    offA();
    offA();
    expect(last().sent.filter((m) => m.type === 'unsubscribe')).toHaveLength(0);
    offB();
    expect(last().sent.filter((m) => m.type === 'unsubscribe')).toEqual([
      expect.objectContaining({ payload: { streamId: S } }),
    ]);

    last().drop();
    vi.advanceTimersByTime(500);
    expect(connect().subscribes()).toEqual([]);
  });
});

describe('BoardClient requests', () => {
  it('correlates action.result replies', async () => {
    const { client, connect, last } = setup();
    client.start();
    connect();
    const done = client.action({ kind: 'terminal.focus', terminalId: 't1' });
    const failed = client.action({ kind: 'terminal.interrupt', terminalId: 't1' });
    const [first, second] = last().sent;
    expect(first).toMatchObject({ type: 'action', payload: { kind: 'terminal.focus' } });
    last().receive(
      makeMessage<ServerToUi>('action.result', { id: second?.id ?? '', ok: false, error: 'nope' }),
    );
    last().receive(makeMessage<ServerToUi>('action.result', { id: first?.id ?? '', ok: true }));
    await expect(done).resolves.toEqual({ ok: true });
    await expect(failed).resolves.toEqual({ ok: false, error: 'nope' });
  });

  it('passes the launched editor through and tells action listeners', async () => {
    const { client, connect, last } = setup();
    client.start();
    connect();
    const heard: [string, unknown][] = [];
    const stop = client.onAction((action, result) => heard.push([action.kind, result]));
    const opened = client.action({ kind: 'project.openInEditor', projectId: 'p1' });
    const [sent] = last().sent;
    last().receive(
      makeMessage<ServerToUi>('action.result', { id: sent?.id ?? '', ok: true, editor: 'VS Code' }),
    );
    await expect(opened).resolves.toEqual({ ok: true, editor: 'VS Code' });
    expect(heard).toEqual([['project.openInEditor', { ok: true, editor: 'VS Code' }]]);
    stop();
    const focused = client.action({ kind: 'terminal.focus', terminalId: 't1' });
    const next = last().sent.at(-1);
    last().receive(makeMessage<ServerToUi>('action.result', { id: next?.id ?? '', ok: true }));
    await focused;
    expect(heard).toHaveLength(1);
  });

  it('fails fast offline, on disconnect, on timeout and for invalid payloads', async () => {
    const { client, connect, last, logger } = setup({ requestTimeoutMs: 1000 });
    client.start();
    await expect(client.action({ kind: 'terminal.focus', terminalId: 't1' })).resolves.toEqual({
      ok: false,
      error: 'offline',
    });

    connect();
    const lost = client.action({ kind: 'terminal.focus', terminalId: 't1' });
    last().drop();
    await expect(lost).resolves.toEqual({ ok: false, error: 'disconnected' });

    vi.advanceTimersByTime(500);
    connect();
    const slow = client.request('approval.decide', { approvalId: 'a1', decision: 'allow' });
    vi.advanceTimersByTime(1000);
    await expect(slow).resolves.toEqual({ ok: false, error: 'timeout' });

    const bad = client.request('session.send', { sessionId: 's1', text: '' });
    await expect(bad).resolves.toEqual({ ok: false, error: 'invalid_message' });
    expect(logger.warn).toHaveBeenCalledWith(
      'dropped invalid outgoing message',
      expect.any(String),
    );
  });
});

describe('BoardClient board terminals', () => {
  it('sends keystrokes and sizes, splitting a big paste between surrogate pairs', () => {
    const { client, connect, last } = setup();
    client.start();
    client.terminalInput('b1', 'lost');
    connect();
    client.terminalInput('b1', 'ls\r');
    client.terminalResize('b1', 100, 30);
    const paste = `${'x'.repeat(MAX_TERMINAL_INPUT - 1)}😀tail`;
    client.terminalInput('b1', paste);
    const sent = last().sent.filter((m) => m.type.startsWith('terminal.'));
    expect(sent.map((m) => [m.type, m.payload])).toEqual([
      ['terminal.input', { terminalId: 'b1', data: 'ls\r' }],
      ['terminal.resize', { terminalId: 'b1', cols: 100, rows: 30 }],
      ['terminal.input', { terminalId: 'b1', data: 'x'.repeat(MAX_TERMINAL_INPUT - 1) }],
      ['terminal.input', { terminalId: 'b1', data: '😀tail' }],
    ]);
    expect(sent.every((m) => m.id === undefined)).toBe(true);
  });
});

describe('activity', () => {
  it('feeds activity batches into the store', () => {
    const { store, client, connect } = setup();
    client.start();
    const socket = connect();
    const event = {
      id: 'evt-1',
      ts: T0,
      kind: 'prompt' as const,
      projectId: 'p-acme',
      sessionId: null,
      terminalId: null,
      execId: null,
      summary: 'Fix the cart',
      data: {},
    };
    socket.receive(makeMessage<ServerToUi>('activity', { events: [event], replace: true }));
    expect(store.getState().activity).toEqual([event]);
    socket.receive(
      makeMessage<ServerToUi>('activity', { events: [{ ...event, id: 'evt-2' }], replace: false }),
    );
    expect(store.getState().activity.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
    client.stop();
  });
});
