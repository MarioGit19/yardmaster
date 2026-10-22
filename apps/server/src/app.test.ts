import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerStatus } from '@c-board/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { buildServer, startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { generateToken } from './token.js';

const config: ServerConfig = {
  port: 4317,
  host: '127.0.0.1',
  home: '/home/dev/.c-board',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const host = '127.0.0.1:4317';

let app: FastifyInstance | undefined;
let tmpHome: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  tmpHome = undefined;
});

describe('server', () => {
  it('GET /api/health returns ok and the package version', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:' });
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ ok: true, version: pkg.version });
  });

  it('GET /api/status needs auth and reports editors and hook stats', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:' });
    const denied = await app.inject({ method: 'GET', url: '/api/status', headers: { host } });
    expect(denied.statusCode).toBe(401);

    app.hookStats.received = 3;
    app.hookStats.lastAt = 1_800_000_000_000;
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host, 'x-cboard-token': token },
    });
    expect(res.statusCode).toBe(200);
    const body = ServerStatus.parse(res.json());
    expect(body).toMatchObject({
      ok: true,
      version: pkg.version,
      demo: false,
      editors: 0,
      hooks: { received: 3, lastAt: 1_800_000_000_000 },
    });
  });

  it('returns 404 for unknown routes', async () => {
    app = await buildServer(config, { token, dbPath: ':memory:' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { host, 'x-cboard-token': token },
    });
    expect(res.statusCode).toBe(404);
  });

  it('listens on loopback and serves health over HTTP', async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'cboard-app-'));
    app = await startServer({ ...config, port: 0, home: tmpHome });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    expect(address.address).toBe('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: pkg.version });
  });
});
