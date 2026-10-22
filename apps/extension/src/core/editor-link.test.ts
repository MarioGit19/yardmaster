import type { AddressInfo } from 'node:net';
import { EDITOR_CLOSE_REPLACED } from '@c-board/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { backoffDelay, EditorLink, type HelloPayload, type LinkStatus } from './editor-link.js';

const token = `${'tok'.repeat(14)}x`;
const hello: HelloPayload = {
  windowId: '3b8e6f0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  appName: 'Cursor',
  appVersion: '1.93.0',
  workspaceFolders: ['/home/dev/acme-shop'],
  extensionVersion: '0.1.0',
  capabilities: { shellExecution: true },
};

interface Received {
  type: string;
  payload: Record<string, unknown>;
}

/** A stand-in for the c-board server's `/ws/editor`. */
class FakeServer {
  readonly wss: WebSocketServer;
  readonly received: Received[] = [];
  readonly headers: (string | undefined)[] = [];
  readonly sockets: WebSocket[] = [];
  connections = 0;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on('connection', (socket, request) => {
      this.connections += 1;
      this.sockets.push(socket);
      this.headers.push(request.headers['x-cboard-token'] as string | undefined);
      socket.on('message', (data) => this.received.push(JSON.parse(data.toString())));
    });
  }

  static async start(port = 0): Promise<FakeServer> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    return new FakeServer(wss);
  }

  get port(): number {
    return (this.wss.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ws/editor`;
  }

  types(): string[] {
    return this.received.map((message) => message.type);
  }

  async stop(): Promise<void> {
    for (const socket of this.wss.clients) socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

const servers: FakeServer[] = [];
const links: EditorLink[] = [];

afterEach(async () => {
  for (const link of links.splice(0)) link.stop();
  for (const server of servers.splice(0)) await server.stop();
});

async function server(port?: number): Promise<FakeServer> {
  const s = await FakeServer.start(port);
  servers.push(s);
  return s;
}

function link(
  url: string,
  overrides: Partial<ConstructorParameters<typeof EditorLink>[0]> = {},
): { link: EditorLink; statuses: LinkStatus[] } {
  const statuses: LinkStatus[] = [];
  const l = new EditorLink({
    url,
    readToken: async () => token,
    hello: () => hello,
    onStatus: (status) => statuses.push(status),
    minBackoffMs: 20,
    maxBackoffMs: 40,
    random: () => 0.5,
    ...overrides,
  });
  links.push(l);
  return { link: l, statuses };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A port nothing listens on: bind one, then release it. */
async function freePort(): Promise<number> {
  const s = await FakeServer.start();
  const port = s.port;
  await s.stop();
  return port;
}

describe('backoffDelay', () => {
  it('doubles from the minimum up to the cap', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 10].map((n) => backoffDelay(n, 500, 30_000, mid))).toEqual([
      500, 1_000, 2_000, 4_000, 30_000,
    ]);
  });

  it('jitters by ±25 %', () => {
    expect(backoffDelay(0, 1_000, 30_000, () => 0)).toBe(750);
    expect(backoffDelay(0, 1_000, 30_000, () => 1)).toBe(1_250);
  });
});

describe('EditorLink', () => {
  it('connects with the token header and sends hello first', async () => {
    const s = await server();
    const { link: l, statuses } = link(s.url);
    l.start();
    await waitFor(() => s.received.length > 0);

    expect(s.headers).toEqual([token]);
    expect(s.received[0]).toMatchObject({ v: 1, type: 'editor.hello', payload: hello });
    expect(statuses.map((status) => status.kind)).toEqual(['connecting', 'connected']);
    expect(l.status.kind).toBe('connected');
  });

  it('sends heartbeats while connected', async () => {
    const s = await server();
    const { link: l } = link(s.url, { heartbeatMs: 20 });
    l.start();
    await waitFor(() => s.types().filter((type) => type === 'editor.heartbeat').length >= 2);
    expect(l.status.kind).toBe('connected');
  });

  it('re-sends hello on demand', async () => {
    const s = await server();
    const { link: l } = link(s.url);
    l.start();
    await waitFor(() => l.status.kind === 'connected');
    l.sendHello();
    await waitFor(() => s.types().length === 2);
    expect(s.types()).toEqual(['editor.hello', 'editor.hello']);
  });

  it('retries without a token, and connects once one appears', async () => {
    const s = await server();
    let current: string | null = null;
    const { link: l, statuses } = link(s.url, { readToken: async () => current });
    l.start();
    await waitFor(() => l.status.kind === 'disconnected');
    expect(statuses[1]).toMatchObject({ kind: 'disconnected', retryInMs: 20 });
    expect(s.connections).toBe(0);

    current = token;
    await waitFor(() => l.status.kind === 'connected');
    expect(s.headers).toEqual([token]);
  });

  it('reconnects with backoff after the server goes away', async () => {
    const s = await server();
    const port = s.port;
    const { link: l, statuses } = link(s.url);
    l.start();
    await waitFor(() => l.status.kind === 'connected');

    await s.stop();
    servers.splice(servers.indexOf(s), 1);
    await waitFor(() => statuses.filter((status) => status.kind === 'disconnected').length >= 2);
    const delays = statuses.flatMap((status) =>
      status.kind === 'disconnected' ? [status.retryInMs] : [],
    );
    expect(delays.slice(0, 2)).toEqual([20, 40]);
    const reasons = statuses.flatMap((status) =>
      status.kind === 'disconnected' ? [status.reason] : [],
    );
    expect(reasons.slice(0, 2)).toEqual([
      'the server closed the connection',
      'the server is not running',
    ]);

    const restarted = await server(port);
    await waitFor(() => l.status.kind === 'connected');
    await waitFor(() => restarted.received.length > 0);
    expect(restarted.received[0]?.type).toBe('editor.hello');
  });

  it('reports a rejected token and keeps retrying', async () => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, done) => done(false, 401),
    });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    const { link: l, statuses } = link(`ws://127.0.0.1:${port}/ws/editor`);
    l.start();
    await waitFor(() => statuses.filter((status) => status.kind === 'disconnected').length >= 2);
    expect(statuses.find((status) => status.kind === 'disconnected')).toMatchObject({
      reason: 'the server rejected the token',
    });
    l.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('queues messages while offline and flushes them after hello', async () => {
    const port = await freePort();
    const { link: l } = link(`ws://127.0.0.1:${port}/ws/editor`);
    l.start();
    l.send('terminal.closed', { terminalId: 'term-1', exitCode: 0 });
    l.send('terminal.closed', { terminalId: 'term-2', exitCode: null });
    expect(l.queued).toBe(2);

    const s = await server(port);
    await waitFor(() => s.received.length === 3);
    expect(s.types()).toEqual(['editor.hello', 'terminal.closed', 'terminal.closed']);
    expect(s.received.slice(1).map((message) => message.payload.terminalId)).toEqual([
      'term-1',
      'term-2',
    ]);
    expect(l.queued).toBe(0);
  });

  it('caps the offline queue by count, dropping the oldest', async () => {
    const port = await freePort();
    const { link: l } = link(`ws://127.0.0.1:${port}/ws/editor`, { maxQueuedMessages: 3 });
    l.start();
    for (let i = 0; i < 10; i += 1) {
      l.send('terminal.closed', { terminalId: `term-${i}`, exitCode: 0 });
    }
    expect(l.queued).toBe(3);
    expect(l.dropped).toBe(7);

    const s = await server(port);
    await waitFor(() => s.received.length === 4);
    expect(s.received.slice(1).map((message) => message.payload.terminalId)).toEqual([
      'term-7',
      'term-8',
      'term-9',
    ]);
  });

  it('caps the offline queue by size', async () => {
    const port = await freePort();
    const { link: l } = link(`ws://127.0.0.1:${port}/ws/editor`, { maxQueuedBytes: 2_000 });
    l.start();
    const chunk = 'x'.repeat(800);
    for (let seq = 0; seq < 5; seq += 1) l.send('exec.data', { execId: 'exec-1', seq, chunk });
    expect(l.queued).toBe(2);
    expect(l.dropped).toBe(3);
  });

  it('drops invalid outgoing messages instead of sending them', async () => {
    const s = await server();
    const { link: l } = link(s.url);
    l.start();
    await waitFor(() => l.status.kind === 'connected');
    l.send('terminal.closed', { terminalId: '', exitCode: 0 });
    l.send('terminal.closed', { terminalId: 'term-1', exitCode: 0 });
    await waitFor(() => s.received.length === 2);
    expect(s.received[1]?.payload.terminalId).toBe('term-1');
  });

  it('stops retrying when another connection replaces it', async () => {
    const s = await server();
    const { link: l } = link(s.url);
    l.start();
    await waitFor(() => s.sockets.length === 1);
    s.sockets[0]?.close(EDITOR_CLOSE_REPLACED, 'replaced');
    await waitFor(() => l.status.kind === 'replaced');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(s.connections).toBe(1);

    l.reconnect();
    await waitFor(() => l.status.kind === 'connected');
    expect(s.connections).toBe(2);
  });

  it('passes valid server commands on and ignores invalid ones', async () => {
    const s = await server();
    const commands: string[] = [];
    const { link: l } = link(s.url, { onCommand: (command) => commands.push(command.type) });
    l.start();
    await waitFor(() => s.sockets.length === 1);
    const socket = s.sockets[0];
    socket?.send('nope');
    socket?.send(JSON.stringify({ v: 1, type: 'cmd.focusTerminal', ts: 1, payload: {} }));
    socket?.send(
      JSON.stringify({
        v: 1,
        type: 'cmd.focusTerminal',
        id: 'cmd-1',
        ts: 1,
        payload: { terminalId: 'term-1' },
      }),
    );
    await waitFor(() => commands.length === 1);
    expect(commands).toEqual(['cmd.focusTerminal']);
  });

  it('closes the socket and clears the queue on stop', async () => {
    const s = await server();
    const { link: l } = link(s.url);
    l.start();
    await waitFor(() => s.sockets.length === 1);
    const closed = new Promise<number>((resolve) => s.sockets[0]?.once('close', resolve));
    l.stop();
    expect(await closed).toBe(1000);
    l.send('terminal.closed', { terminalId: 'term-1', exitCode: 0 });
    expect(l.status.kind).toBe('stopped');
    expect(l.queued).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.connections).toBe(1);
  });
});
