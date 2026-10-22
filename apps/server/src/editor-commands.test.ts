import type { AddressInfo } from 'node:net';
import { decodeServerToEditor, type ServerToEditor, type ServerToUi } from '@c-board/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { INVALID_SESSION_ID } from './editor-actions.js';
import { COMMAND_ERRORS, EDITOR_WS_PATH } from './editor-gateway.js';
import { ROUTE_ERRORS } from './editor-router.js';
import { createSessionValue, TOKEN_HEADER } from './security.js';
import { TERMINAL_REPLY_DISABLED } from './terminal-reply.js';
import { generateToken } from './token.js';
import { UI_WS_PATH } from './ui-gateway.js';

const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  home: '/home/dev/.c-board',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const TIMEOUT_MS = 120;
const windowId = '3c1d9e2a-5b4f-4a6e-8d7c-0b1a2c3d4e5f';
const shopPath = '/home/dev/acme-shop';

let app: FastifyInstance | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
});

async function boot(): Promise<{ app: FastifyInstance; port: number }> {
  app = await startServer(config, {
    token,
    dbPath: ':memory:',
    processes: false,
    editor: { resolvePath: async (path) => path, commandTimeoutMs: TIMEOUT_MS },
  });
  return { app, port: (app.server.address() as AddressInfo).port };
}

/** A socket that queues every message it receives. */
class Peer<M> {
  private readonly queue: M[] = [];
  private readonly waiters: ((message: M) => void)[] = [];

  constructor(
    readonly socket: WebSocket,
    parse: (data: string) => M | null,
  ) {
    sockets.push(socket);
    socket.on('message', (data) => {
      const message = parse(data.toString());
      if (message === null) return;
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

  next(timeoutMs = 2_000): Promise<M> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a message')),
        timeoutMs,
      );
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  send(type: string, payload: unknown, id?: string): void {
    this.socket.send(JSON.stringify({ v: 1, type, ts: Date.now(), payload, id }));
  }
}

async function editor(port: number, id = windowId): Promise<Peer<ServerToEditor>> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${EDITOR_WS_PATH}`, {
    headers: { [TOKEN_HEADER]: token },
  });
  const peer = new Peer<ServerToEditor>(socket, (data) => {
    const decoded = decodeServerToEditor(data);
    return decoded.ok ? decoded.message : null;
  });
  await peer.opened();
  peer.send('editor.hello', {
    windowId: id,
    appName: 'Cursor',
    appVersion: '1.93.0',
    workspaceFolders: [shopPath],
    extensionVersion: '0.1.0',
    capabilities: { shellExecution: true },
  });
  peer.send('terminal.upsert', {
    terminalId: 'term-1',
    name: 'zsh',
    shellPid: 4242,
    cwd: shopPath,
    state: 'open',
    shellIntegration: true,
    active: true,
    exitCode: null,
  });
  return peer;
}

async function ui(port: number): Promise<Peer<ServerToUi>> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, {
    headers: {
      origin: `http://127.0.0.1:${port}`,
      cookie: `cboard_session=${createSessionValue(token)}`,
    },
  });
  const peer = new Peer<ServerToUi>(socket, (data) => {
    const message = JSON.parse(data) as ServerToUi;
    return message.type === 'action.result' ? message : null;
  });
  await peer.opened();
  return peer;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ready = (app: FastifyInstance) =>
  waitFor(() => app.store.state.terminals['term-1'] !== undefined);

describe('editor commands', () => {
  it('routes a UI action to the owning editor and relays its ack', async () => {
    const { app, port } = await boot();
    const ed = await editor(port);
    await ready(app);
    const client = await ui(port);

    client.send(
      'action',
      { kind: 'terminal.sendText', terminalId: 'term-1', text: 'ls', execute: true },
      'act-1',
    );
    const command = await ed.next();
    expect(command).toMatchObject({
      type: 'cmd.sendText',
      payload: { terminalId: 'term-1', text: 'ls', execute: true },
    });
    ed.send('cmd.result', { id: command.id, ok: true });
    expect((await client.next()).payload).toEqual({ id: 'act-1', ok: true });

    client.send('action', { kind: 'terminal.create', projectId: projectIdOf(app) }, 'act-2');
    const create = await ed.next();
    expect(create).toMatchObject({
      type: 'cmd.createTerminal',
      payload: { cwd: shopPath, name: 'acme-shop' },
    });
    ed.send('cmd.result', { id: create.id, ok: false, error: 'cwd_missing' });
    expect((await client.next()).payload).toEqual({ id: 'act-2', ok: false, error: 'cwd_missing' });
  });

  it('resumes a past session in a new editor terminal', async () => {
    const { app, port } = await boot();
    const ed = await editor(port);
    await ready(app);
    const client = await ui(port);
    const sessionId = '6f1c2a9e-0d3b-4c55-9a77-1b2c3d4e5f60';

    client.send(
      'action',
      { kind: 'session.resumeInEditor', projectId: projectIdOf(app), sessionId },
      'r-1',
    );
    const create = await ed.next();
    expect(create).toMatchObject({
      type: 'cmd.createTerminal',
      payload: {
        cwd: shopPath,
        name: 'claude · acme-shop',
        command: `claude --resume ${sessionId}`,
      },
    });
    ed.send('cmd.result', { id: create.id, ok: true });
    expect((await client.next()).payload).toEqual({ id: 'r-1', ok: true });

    // An id that isn't a plain token never reaches a shell.
    client.send(
      'action',
      { kind: 'session.resumeInEditor', projectId: projectIdOf(app), sessionId: 'x; touch pwned' },
      'r-2',
    );
    expect((await client.next()).payload).toEqual({
      id: 'r-2',
      ok: false,
      error: INVALID_SESSION_ID,
    });
    client.send('action', { kind: 'session.resumeInEditor', projectId: 'nope', sessionId }, 'r-3');
    expect((await client.next()).payload).toEqual({
      id: 'r-3',
      ok: false,
      error: ROUTE_ERRORS.unknownProject,
    });
  });

  it("types a terminal session's reply into its terminal once the flag is on", async () => {
    const { app, port } = await boot();
    const ed = await editor(port);
    await ready(app);
    const client = await ui(port);
    const sessionId = '2d4f6a8c-0e1b-4c3d-9e5f-7a9b1c3d5e7f';
    app.store.upsertSession({
      id: sessionId,
      origin: 'terminal',
      terminalId: 'term-1',
      status: { kind: 'waiting_input' },
    });
    const reply = { kind: 'session.replyInTerminal', sessionId, text: 'run the tests' };

    client.send('action', reply, 'reply-1');
    expect((await client.next()).payload).toEqual({
      id: 'reply-1',
      ok: false,
      error: TERMINAL_REPLY_DISABLED,
    });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token },
      payload: { experimentalTerminalReply: true },
    });
    expect(put.json()).toMatchObject({ experimentalTerminalReply: true });
    client.send('action', reply, 'reply-2');
    const command = await ed.next();
    expect(command).toMatchObject({
      type: 'cmd.sendText',
      payload: { terminalId: 'term-1', text: 'run the tests', execute: true },
    });
    ed.send('cmd.result', { id: command.id, ok: true });
    expect((await client.next()).payload).toEqual({ id: 'reply-2', ok: true });

    // Mid-turn, the line would land in Claude's input box half-typed: refused.
    app.store.setSessionStatus(sessionId, { kind: 'working' });
    client.send('action', reply, 'reply-3');
    expect((await client.next()).payload).toEqual({
      id: 'reply-3',
      ok: false,
      error: 'session_busy',
    });
    await expect(ed.next(50)).rejects.toThrow('timed out');
  });

  it('times out when the editor never answers', async () => {
    const { app, port } = await boot();
    const ed = await editor(port);
    await ready(app);
    const started = Date.now();
    const result = app.editorGateway.sendCommand(windowId, 'cmd.focusTerminal', {
      terminalId: 'term-1',
    });
    expect((await ed.next()).type).toBe('cmd.focusTerminal');
    expect(await result).toEqual({ ok: false, error: COMMAND_ERRORS.timeout });
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 5);

    // A late answer is ignored.
    ed.send('cmd.result', { id: 'late', ok: true });
    await app.editorGateway.idle();
  });

  it('fails pending commands when the editor disconnects', async () => {
    const { app, port } = await boot();
    const ed = await editor(port);
    await ready(app);
    const result = app.editorGateway.sendCommand(windowId, 'cmd.interrupt', {
      terminalId: 'term-1',
    });
    await ed.next();
    ed.socket.close();
    expect(await result).toEqual({ ok: false, error: COMMAND_ERRORS.disconnected });
    expect(
      await app.editorGateway.sendCommand(windowId, 'cmd.interrupt', { terminalId: 'term-1' }),
    ).toEqual({ ok: false, error: COMMAND_ERRORS.offline });
  });

  it('only accepts a result from the connection the command went to', async () => {
    const { app, port } = await boot();
    const ed = await editor(port);
    await ready(app);
    const other = await editor(port, '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d');
    await waitFor(() => Object.keys(app.store.state.windows).length === 2);

    const result = app.editorGateway.sendCommand(windowId, 'cmd.disposeTerminal', {
      terminalId: 'term-1',
    });
    const command = await ed.next();
    other.send('cmd.result', { id: command.id, ok: false, error: 'spoofed' });
    await app.editorGateway.idle();
    ed.send('cmd.result', { id: command.id, ok: true });
    expect(await result).toEqual({ ok: true });
  });

  it('answers routing errors without contacting an editor', async () => {
    const { app, port } = await boot();
    const ed = await editor(port);
    await ready(app);
    const client = await ui(port);
    client.send('action', { kind: 'terminal.focus', terminalId: 'missing' }, 'act-1');
    expect((await client.next()).payload).toEqual({
      id: 'act-1',
      ok: false,
      error: ROUTE_ERRORS.unknownTerminal,
    });
    await expect(ed.next(50)).rejects.toThrow('timed out');
  });
});

function projectIdOf(app: FastifyInstance): string {
  const project = Object.values(app.store.state.projects).find((p) => p.path === shopPath);
  if (!project) throw new Error('project not registered');
  return project.id;
}
