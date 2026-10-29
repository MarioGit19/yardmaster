import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardLinkResponse, LOCAL_ONLY_ROUTES } from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { MAX_SOCKET_PATH_BYTES, socketPath } from './local-channel.js';
import { localInject } from './local-channel.test-helpers.js';
import { generateToken, writeToken } from './token.js';

const token = generateToken();
let app: FastifyInstance | undefined;
let home: string | undefined;
const others: Server[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const server of others.splice(0)) await new Promise((resolve) => server.close(resolve));
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function freshHome(mode = 0o700): Promise<string> {
  home = await mkdtemp(join(tmpdir(), 'ym-local-'));
  await writeToken(home, token);
  await chmod(home, mode);
  return home;
}

async function boot(dir?: string): Promise<FastifyInstance> {
  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    home: dir ?? (await freshHome()),
    logLevel: 'silent',
    devOrigins: [],
  };
  app = await startServer(config, { token, dbPath: ':memory:', processes: false, git: false });
  return app;
}

const tokenHeader = { 'x-yardmaster-token': token };
const host = (server: FastifyInstance) =>
  `127.0.0.1:${(server.server.address() as AddressInfo).port}`;

/** A request over the socket `startServer` opened in the data dir (not a test one). */
function overSocket(server: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  const state = server.localChannel.state;
  if (state?.kind !== 'listening') throw new Error('no socket');
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: state.path, path: url, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the local socket', () => {
  it('listens in the data dir, owner only, and tightens an open dir', async () => {
    const dir = await freshHome(0o755);
    const server = await boot(dir);
    expect(server.localChannel.state).toEqual({ kind: 'listening', path: socketPath(dir) });
    const socket = await lstat(socketPath(dir));
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('serves the API with the token, never the web app or the UI socket', async () => {
    const server = await boot();
    expect((await overSocket(server, '/api/health')).statusCode).toBe(200);
    expect((await overSocket(server, '/api/status')).statusCode).toBe(401);
    expect((await overSocket(server, '/api/status', tokenHeader)).statusCode).toBe(200);
    for (const path of ['/', '/auth', '/ws/ui', '/index.html']) {
      expect((await overSocket(server, path, tokenHeader)).statusCode).toBe(404);
    }
    // No browser can reach a socket; a request that says it came from one is refused.
    const fromPage = await overSocket(server, '/api/status', {
      ...tokenHeader,
      origin: 'http://127.0.0.1:4317',
    });
    expect(fromPage.statusCode).toBe(403);
  });

  it('refuses every editor and hook route over TCP, even with the token', async () => {
    const server = await boot();
    for (const url of [...LOCAL_ONLY_ROUTES, '/api/hooks/%63laude', '/api/%61way']) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await server.inject({
          method,
          url,
          headers: { host: host(server), ...tokenHeader },
        });
        expect([403, 404]).toContain(res.statusCode);
        if (res.statusCode === 403) expect(res.json()).toEqual({ error: 'local_channel_required' });
      }
    }
  });

  it('hands the extension its sign-in link, for the port the board holds', async () => {
    const server = await boot();
    const res = await localInject(server, {
      method: 'POST',
      url: '/api/local/dashboard-link',
      headers: tokenHeader,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { url } = DashboardLinkResponse.parse(res.json());
    expect(url).toBe(`http://${host(server)}/auth?t=${token}`);
    const unauthorized = await localInject(server, {
      method: 'POST',
      url: '/api/local/dashboard-link',
    });
    expect(unauthorized.statusCode).toBe(401);
  });

  it('removes its socket when it stops, but not one a newer server put there', async () => {
    const dir = await freshHome();
    const server = await boot(dir);
    await server.close();
    app = undefined;
    await expect(lstat(socketPath(dir))).rejects.toThrow();

    const second = await boot(dir);
    // Another server took the path over (say, a restart under a file watcher).
    await rm(socketPath(dir));
    const newer = createServer();
    others.push(newer);
    await new Promise<void>((resolve) => newer.listen(socketPath(dir), () => resolve()));
    await second.close();
    app = undefined;
    expect((await lstat(socketPath(dir))).isSocket()).toBe(true);
  });

  it('replaces a stale socket of ours', async () => {
    const dir = await freshHome();
    // A server that crashed leaves a socket file nobody answers on.
    const script = `require('node:net').createServer().listen(${JSON.stringify(socketPath(dir))}, () => process.kill(process.pid, 'SIGKILL'))`;
    spawnSync(process.execPath, ['-e', script]);
    const { ino } = await lstat(socketPath(dir));
    const server = await boot(dir);
    expect(server.localChannel.state?.kind).toBe('listening');
    expect((await lstat(socketPath(dir))).ino).not.toBe(ino);
  });

  it('leaves anything that is not its socket alone, and runs without one', async () => {
    const dir = await freshHome();
    await writeFile(socketPath(dir), 'not a socket');
    const server = await boot(dir);
    expect(server.localChannel.state).toMatchObject({
      kind: 'unavailable',
      reason: 'something other than a socket is in the way',
    });
    expect(await readFile(socketPath(dir), 'utf8')).toBe('not a socket');
    // The board itself still serves browsers.
    const res = await server.inject({ url: '/api/health', headers: { host: host(server) } });
    expect(res.statusCode).toBe(200);
  });

  it('does not take over a socket another server answers on', async () => {
    const dir = await freshHome();
    const other = createServer((_req, res) => res.end());
    others.push(other);
    await new Promise<void>((resolve) => other.listen(socketPath(dir), () => resolve()));
    const server = await boot(dir);
    expect(server.localChannel.state).toMatchObject({
      kind: 'unavailable',
      reason: 'another Yardmaster server is using it',
    });
  });

  it('reports a data dir whose socket path is too long', async () => {
    const dir = await freshHome();
    const deep = join(dir, 'x'.repeat(MAX_SOCKET_PATH_BYTES));
    const server = await boot(deep);
    expect(server.localChannel.state).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/too long/),
    });
  });

  it('runs without a socket when the data dir does not exist', async () => {
    const dir = await freshHome();
    const server = await boot(join(dir, 'missing'));
    expect(server.localChannel.state?.kind).toBe('unavailable');
  });
});
