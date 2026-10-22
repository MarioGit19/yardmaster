import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { buildServer, startServer } from './app.js';
import type { ServerConfig } from './config.js';

const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  home: '/home/dev/.c-board',
  logLevel: 'silent',
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('server', () => {
  it('GET /api/health returns ok and the package version', async () => {
    app = await buildServer(config);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ ok: true, version: pkg.version });
  });

  it('returns 404 for unknown routes', async () => {
    app = await buildServer(config);
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('listens on loopback and serves health over HTTP', async () => {
    app = await startServer(config);
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    expect(address.address).toBe('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: pkg.version });
  });
});
