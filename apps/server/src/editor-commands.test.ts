import type { AddressInfo } from 'node:net';
import { decodeServerToEditor, type ServerToEditor, type ServerToUi } from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { INVALID_SESSION_ID } from './editor-actions.js';
import { COMMAND_ERRORS, EDITOR_WS_PATH } from './editor-gateway.js';
import { ROUTE_ERRORS } from './editor-router.js';
import { localSocket, localWebSocket } from './local-channel.test-helpers.js';
import { OUTSIDE_LIBRARY } from './project-actions.js';
import { TOKEN_HEADER } from './security.js';
import { sessionHeader } from './sessions.test-helpers.js';
import { TERMINAL_REPLY_DISABLED } from './terminal-reply.js';
import { generateToken } from './token.js';
import { UI_WS_PATH } from './ui-gateway.js';

const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  home: '/home/dev/.yardmaster',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const TIMEOUT_MS = 120;
const windowId = '3c1d9e2a-5b4f-4a6e-8d7c-0b1a2c3d4e5f';
const shopPath = '/home/dev/acme-shop';

let app: FastifyInstance | undefined;
const sockets: WebSocket[] = [];
/** Each app's socket, by its TCP port. */
const socketPaths = new Map<number, string>();

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
  const port = (app.server.address() as AddressInfo).port;
  socketPaths.set(port, await localSocket(app));
  return { app, port };
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
  const socket = localWebSocket(socketPaths.get(port) ?? '', EDITOR_WS_PATH, {
    [TOKEN_HEADER]: token,
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
      ...sessionHeader(app as FastifyInstance),
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

  it("types a terminal session's reply into its terminal while the setting is on", async () => {
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
    const setReply = (terminalReply: boolean) =>
      app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token },
        payload: { terminalReply },
      });

    expect((await setReply(false)).json()).toMatchObject({ terminalReply: false });
    client.send('action', reply, 'reply-1');
    expect((await client.next()).payload).toEqual({
      id: 'reply-1',
      ok: false,
      error: TERMINAL_REPLY_DISABLED,
    });

    expect((await setReply(true)).json()).toMatchObject({ terminalReply: true });
    client.send('action', reply, 'reply-2');
    // Pasted, then Enter on its own.
    const paste = await ed.next();
    expect(paste).toMatchObject({
      type: 'cmd.sendText',
      payload: { terminalId: 'term-1', text: '\x1b[200~run the tests\x1b[201~', execute: false },
    });
    ed.send('cmd.result', { id: paste.id, ok: true });
    const enter = await ed.next();
    expect(enter).toMatchObject({
      type: 'cmd.sendText',
      payload: { terminalId: 'term-1', text: '\r', execute: false },
    });
    ed.send('cmd.result', { id: enter.id, ok: true });
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

  it('opens a library project with the editor CLI, and refuses one outside the roots', async () => {
    const spawned: [string, string[]][] = [];
    const ptys: { cwd: string; writes: string[]; sizes: [number, number][] }[] = [];
    app = await startServer(config, {
      pty: {
        // A shell without the integration: the launch command is typed at once.
        shell: { file: '/bin/sh', args: [] },
        load: async () => ({
          ok: true,
          spawn: (_file, _args, options) => {
            const pty = {
              cwd: options.cwd,
              writes: [] as string[],
              sizes: [] as [number, number][],
            };
            ptys.push(pty);
            return {
              pid: 4242,
              onData: () => ({ dispose() {} }),
              onExit: () => ({ dispose() {} }),
              write: (data: string) => pty.writes.push(data),
              resize: (cols: number, rows: number) => pty.sizes.push([cols, rows]),
              kill: () => {},
            };
          },
        }),
      },
      token,
      dbPath: ':memory:',
      processes: false,
      git: false,
      library: {
        list: async () => ({ roots: [], entries: [] }),
        resolve: async (roots, path) =>
          roots.includes('/home/dev') && path.startsWith('/home/dev/') ? path : null,
      },
      editorCli: {
        deps: {
          env: { PATH: '/usr/local/bin' },
          platform: 'linux',
          home: '/home/dev',
          isExecutable: async (path) => path === '/usr/local/bin/cursor',
        },
        spawn: async (file, args) => {
          spawned.push([file, args]);
          return { ok: true };
        },
      },
    });
    app.settings['library.roots'] = ['/home/dev'];
    const port = (app.server.address() as AddressInfo).port;
    socketPaths.set(port, await localSocket(app));
    const client = await ui(port);

    client.send('action', { kind: 'project.add', path: '/home/dev/recipe-box' }, 'o-1');
    expect((await client.next()).payload).toEqual({ id: 'o-1', ok: true });
    const projectId = Object.keys(app.store.state.projects)[0];
    client.send('action', { kind: 'project.openInEditor', projectId }, 'o-2');
    expect((await client.next()).payload).toEqual({ id: 'o-2', ok: true, editor: 'Cursor' });
    expect(spawned).toEqual([['/usr/local/bin/cursor', ['/home/dev/recipe-box']]]);

    // No window has it open yet: a board terminal runs it, and takes raw keystrokes.
    client.send('action', { kind: 'terminal.create', projectId, command: 'pnpm dev' }, 'o-3');
    expect((await client.next()).payload).toEqual({ id: 'o-3', ok: true });
    const board = Object.values(app.store.state.terminals).find((t) => t.origin === 'board');
    expect(board).toMatchObject({ projectId, cwd: '/home/dev/recipe-box', shellPid: 4242 });
    client.send('terminal.input', { terminalId: board?.id, data: '\x03' });
    client.send('terminal.resize', { terminalId: board?.id, cols: 90, rows: 20 });
    await waitFor(() => (ptys[0]?.sizes.length ?? 0) > 0);
    expect(ptys).toEqual([
      { cwd: '/home/dev/recipe-box', writes: ['pnpm dev\r', '\x03'], sizes: [[90, 20]] },
    ]);

    app.settings['library.roots'] = [];
    client.send('action', { kind: 'project.openInEditor', projectId }, 'o-4');
    expect((await client.next()).payload).toEqual({
      id: 'o-4',
      ok: false,
      error: OUTSIDE_LIBRARY,
    });
    expect(spawned).toHaveLength(1);
    client.send('action', { kind: 'terminal.create', projectId }, 'o-5');
    expect((await client.next()).payload).toEqual({
      id: 'o-5',
      ok: false,
      error: OUTSIDE_LIBRARY,
    });
    expect(ptys).toHaveLength(1);
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
