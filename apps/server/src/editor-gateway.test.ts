import type { AddressInfo } from 'node:net';
import { EDITOR_CLOSE_REPLACED, projectIdFromPath } from '@c-board/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { EDITOR_WS_PATH } from './editor-gateway.js';
import { TOKEN_HEADER } from './security.js';
import { generateToken } from './token.js';

const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  home: '/home/dev/.c-board',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const GRACE_MS = 80;

const windowId = '7f9c2b1e-4a3d-4e5f-9b8a-1c2d3e4f5a6b';
const shopPath = '/home/dev/acme-shop';
const apiPath = '/home/dev/acme-api';

let app: FastifyInstance | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState !== WebSocket.CONNECTING) socket.terminate();
  }
  await app?.close();
  app = undefined;
});

async function boot(idleMs?: number): Promise<{ app: FastifyInstance; port: number }> {
  app = await startServer(config, {
    token,
    dbPath: ':memory:',
    editor: { graceMs: GRACE_MS, resolvePath: async (path) => path, idleMs },
  });
  return { app, port: (app.server.address() as AddressInfo).port };
}

function connect(port: number, headers: Record<string, string> = { [TOKEN_HEADER]: token }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${EDITOR_WS_PATH}`, { headers });
  sockets.push(socket);
  return socket;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

function rejectedStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    // Swallow the follow-up abort error so teardown stays quiet.
    socket.on('error', () => {});
    socket.once('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    socket.once('open', () => reject(new Error('socket opened')));
  });
}

function send(socket: WebSocket, type: string, payload: unknown, ts = Date.now()): void {
  socket.send(JSON.stringify({ v: 1, type, ts, payload }));
}

function hello(socket: WebSocket, folders = [shopPath, apiPath], id = windowId): void {
  send(socket, 'editor.hello', {
    windowId: id,
    appName: 'Cursor',
    appVersion: '1.93.0',
    workspaceFolders: folders,
    extensionVersion: '0.1.0',
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('/ws/editor', () => {
  it('refuses connections without a valid token header', async () => {
    const { port } = await boot();
    expect(await rejectedStatus(connect(port, {}))).toBe(401);
    expect(await rejectedStatus(connect(port, { [TOKEN_HEADER]: generateToken() }))).toBe(401);
  });

  it('registers the window and its workspace folders as projects on hello', async () => {
    const { app, port } = await boot();
    const socket = connect(port);
    await opened(socket);
    hello(socket);
    await waitFor(() => app.store.state.windows[windowId] !== undefined);

    const window = app.store.state.windows[windowId];
    const shopId = projectIdFromPath(shopPath);
    const apiId = projectIdFromPath(apiPath);
    expect(window).toMatchObject({
      appName: 'Cursor',
      appVersion: '1.93.0',
      extensionVersion: '0.1.0',
      workspaceFolders: [shopPath, apiPath],
      projectIds: [shopId, apiId],
    });
    expect(app.store.state.projects[shopId]).toMatchObject({
      path: shopPath,
      name: 'acme-shop',
      source: 'editor',
    });
    expect(app.store.state.projects[apiId]?.source).toBe('editor');
  });

  it('updates the window on a repeated hello and on heartbeats', async () => {
    const { app, port } = await boot();
    const socket = connect(port);
    await opened(socket);
    hello(socket, [shopPath]);
    await waitFor(() => app.store.state.windows[windowId] !== undefined);
    const first = app.store.state.windows[windowId];

    await delay(5);
    hello(socket, [shopPath, apiPath]);
    await waitFor(() => app.store.state.windows[windowId]?.projectIds.length === 2);
    expect(app.store.state.windows[windowId]?.connectedAt).toBe(first?.connectedAt);

    const seen = app.store.state.windows[windowId]?.lastSeenAt ?? 0;
    await delay(5);
    send(socket, 'editor.heartbeat', {});
    await waitFor(() => (app.store.state.windows[windowId]?.lastSeenAt ?? 0) > seen);
  });

  it('promotes a project first seen through a hook', async () => {
    const { app, port } = await boot();
    const id = projectIdFromPath(shopPath);
    app.store.upsertProject({
      id,
      path: shopPath,
      name: 'acme-shop',
      accent: 2,
      source: 'hook',
      git: null,
      createdAt: 1_700_000_000_000,
      lastActivityAt: null,
    });
    const socket = connect(port);
    await opened(socket);
    hello(socket, [shopPath]);
    await waitFor(() => app.store.state.windows[windowId] !== undefined);
    expect(app.store.state.projects[id]).toMatchObject({ source: 'editor', accent: 2 });
  });

  it('ignores invalid messages and anything sent before hello', async () => {
    const { app, port } = await boot();
    const socket = connect(port);
    await opened(socket);
    socket.send('not json');
    send(socket, 'editor.hello', { windowId: '' });
    send(socket, 'editor.heartbeat', {});
    send(socket, 'terminal.closed', { terminalId: 't-1', exitCode: 0 });
    await app.editorGateway.idle();
    expect(app.store.state.windows).toEqual({});
    expect(socket.readyState).toBe(WebSocket.OPEN);

    hello(socket);
    await waitFor(() => app.store.state.windows[windowId] !== undefined);
  });

  it('removes the window and its terminals only after the grace period', async () => {
    const { app, port } = await boot();
    const socket = connect(port);
    await opened(socket);
    hello(socket);
    await waitFor(() => app.store.state.windows[windowId] !== undefined);
    app.store.upsertTerminal({ id: 'term-1', windowId, name: 'zsh' });

    const shopId = projectIdFromPath(shopPath);
    socket.close();
    await closed(socket);
    await waitFor(() => app.editorGateway.connectionCount === 0);
    expect(app.store.state.windows[windowId]).toBeDefined();

    await waitFor(() => app.store.state.windows[windowId] === undefined);
    expect(app.store.state.terminals['term-1']).toBeUndefined();
    // Projects outlive the window; they're persisted.
    expect(app.store.state.projects[shopId]).toBeDefined();
  });

  it('keeps the window when it reconnects within the grace period', async () => {
    const { app, port } = await boot();
    const first = connect(port);
    await opened(first);
    hello(first);
    await waitFor(() => app.store.state.windows[windowId] !== undefined);
    app.store.upsertTerminal({ id: 'term-1', windowId, name: 'zsh' });
    first.close();
    await closed(first);

    const second = connect(port);
    await opened(second);
    hello(second);
    await app.editorGateway.idle();
    await delay(GRACE_MS * 2);
    expect(app.store.state.windows[windowId]).toBeDefined();
    expect(app.store.state.terminals['term-1']).toBeDefined();
  });

  it('replaces an older connection for the same window', async () => {
    const { app, port } = await boot();
    const first = connect(port);
    await opened(first);
    hello(first);
    await waitFor(() => app.store.state.windows[windowId] !== undefined);

    const firstClosed = closed(first);
    const second = connect(port);
    await opened(second);
    hello(second);
    expect(await firstClosed).toBe(EDITOR_CLOSE_REPLACED);

    await delay(GRACE_MS * 2);
    expect(app.store.state.windows[windowId]).toBeDefined();
    expect(app.editorGateway.connectionCount).toBe(1);
  });

  it('drops a connection that stops sending heartbeats', async () => {
    const { app, port } = await boot(60);
    const socket = connect(port);
    await opened(socket);
    hello(socket);
    await waitFor(() => app.store.state.windows[windowId] !== undefined);
    await closed(socket);
    await waitFor(() => app.store.state.windows[windowId] === undefined);
  });
});
