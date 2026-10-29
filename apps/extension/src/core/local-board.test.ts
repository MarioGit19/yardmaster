import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { EditorLink, type LinkStatus } from './editor-link.js';
import { isBoardLink, locateBoard, requestDashboardLink } from './local-board.js';

// Synthetic, shaped like a real token (43 base64url chars).
const token = `synthetic_${'y'.repeat(33)}`;
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A private data dir with a token, like `~/.yardmaster`. */
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ym-board-'));
  await chmod(dir, 0o700);
  await writeFile(join(dir, 'token'), `${token}\n`, { mode: 0o600 });
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(
  path: string,
  handler: RequestListener = (_req, res) => res.end(),
): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return server;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('locateBoard', () => {
  it("finds the board's socket and token in a private data dir", async () => {
    const dir = await dataDir();
    await listen(join(dir, 'board.sock'));
    expect(await locateBoard([dir])).toEqual({
      ok: true,
      board: { socketPath: join(dir, 'board.sock'), token },
    });
  });

  it('says the server is not running when there is no socket', async () => {
    const dir = await dataDir();
    expect(await locateBoard([dir])).toEqual({ ok: false, reason: 'the server is not running' });
  });

  it('asks for the server when no dir has a token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ym-board-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    expect(await locateBoard([dir])).toMatchObject({ ok: false, reason: /no token yet/ });
  });

  it('refuses a data dir other users can reach', async () => {
    const dir = await dataDir();
    await listen(join(dir, 'board.sock'));
    await chmod(dir, 0o755);
    expect(await locateBoard([dir])).toMatchObject({ ok: false, reason: /open to other users/ });
  });

  it('refuses a socket owned by someone else', async () => {
    const dir = await dataDir();
    await listen(join(dir, 'board.sock'));
    const other = (process.getuid?.() ?? 0) + 1;
    expect(await locateBoard([dir], other)).toMatchObject({ ok: false });
  });

  it('refuses a regular file or a link in place of the socket', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'board.sock'), '');
    expect(await locateBoard([dir])).toMatchObject({ ok: false, reason: /not a socket of yours/ });

    const elsewhere = await mkdtemp(join(tmpdir(), 'ym-impostor-'));
    cleanup.push(() => rm(elsewhere, { recursive: true, force: true }));
    await listen(join(elsewhere, 'board.sock'));
    const linked = await dataDir();
    await symlink(join(elsewhere, 'board.sock'), join(linked, 'board.sock'));
    expect(await locateBoard([linked])).toMatchObject({ ok: false, reason: /not a socket/ });
  });
});

describe('an impostor that holds the port or plants a socket', () => {
  it('gets no token, no connection and no terminal data from the editor link', async () => {
    // A port-squatting attack: something else bound the board's TCP port before the board started.
    const squatter = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => squatter.once('listening', () => resolve()));
    let squatted = 0;
    squatter.on('connection', () => {
      squatted += 1;
    });
    cleanup.push(() => new Promise((resolve) => squatter.close(() => resolve())));

    // And a socket elsewhere, linked into the data dir.
    const elsewhere = await mkdtemp(join(tmpdir(), 'ym-impostor-'));
    cleanup.push(() => rm(elsewhere, { recursive: true, force: true }));
    const seen: (string | undefined)[] = [];
    await listen(join(elsewhere, 'board.sock'), (req, res) => {
      seen.push(req.headers['x-yardmaster-token'] as string | undefined);
      res.end();
    });
    const dir = await dataDir();
    await symlink(join(elsewhere, 'board.sock'), join(dir, 'board.sock'));

    const statuses: LinkStatus[] = [];
    const link = new EditorLink({
      locate: () => locateBoard([dir]),
      hello: () => ({
        windowId: '3b8e6f0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
        appName: 'Cursor',
        appVersion: '1.93.0',
        workspaceFolders: ['/home/dev/acme-shop'],
        extensionVersion: '0.1.0',
        capabilities: { shellExecution: true },
      }),
      onStatus: (status) => statuses.push(status),
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    link.start();
    link.send('terminal.closed', { terminalId: 'term-1', exitCode: 0 });
    await waitFor(() => statuses.filter((s) => s.kind === 'disconnected').length >= 3);
    link.stop();

    expect(squatted).toBe(0);
    expect(seen).toEqual([]);
    expect(statuses.find((s) => s.kind === 'disconnected')).toMatchObject({
      reason: 'board.sock is not a socket of yours',
    });
  });
});

describe('requestDashboardLink', () => {
  it('returns the sign-in link the board hands out', async () => {
    const dir = await dataDir();
    const seen: (string | undefined)[] = [];
    await listen(join(dir, 'board.sock'), (req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers['x-yardmaster-token']}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: 'http://127.0.0.1:4317/auth?t=abc' }));
    });
    const located = await locateBoard([dir]);
    if (!located.ok) throw new Error(located.reason);
    expect(await requestDashboardLink(located.board)).toBe('http://127.0.0.1:4317/auth?t=abc');
    expect(seen).toEqual([`POST /api/local/dashboard-link ${token}`]);
  });

  it('opens nothing that is not on loopback, or not a link at all', async () => {
    const dir = await dataDir();
    let url: unknown = 'https://attacker.example/phish';
    await listen(join(dir, 'board.sock'), (_req, res) => res.end(JSON.stringify({ url })));
    const board = { socketPath: join(dir, 'board.sock'), token };
    expect(await requestDashboardLink(board)).toBeNull();
    url = 'http://localhost.attacker.example:4317/';
    expect(await requestDashboardLink(board)).toBeNull();
    url = 42;
    expect(await requestDashboardLink(board)).toBeNull();
  });

  it('gives up when nothing answers', async () => {
    const dir = await dataDir();
    expect(await requestDashboardLink({ socketPath: join(dir, 'board.sock'), token })).toBeNull();
  });
});

describe('isBoardLink', () => {
  it('accepts only http on 127.0.0.1 with a port', () => {
    expect(isBoardLink('http://127.0.0.1:4317/auth?t=x')).toBe(true);
    expect(isBoardLink('https://127.0.0.1:4317/')).toBe(false);
    expect(isBoardLink('http://127.0.0.1/')).toBe(false);
    expect(isBoardLink('http://evil.example:4317/')).toBe(false);
    expect(isBoardLink('not a url')).toBe(false);
  });
});
