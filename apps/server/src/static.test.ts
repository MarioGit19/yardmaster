import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './app.js';
import type { ServerConfig } from './config.js';
import { resolveAssetPath } from './static.js';
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
const INDEX = '<!doctype html><title>c-board</title><div id="root"></div>';

let root: string;
let app: FastifyInstance | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'c-board-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), INDEX);
  await writeFile(join(root, 'assets', 'app-3f9a.js'), 'console.log(1)');
  await writeFile(join(root, 'favicon.svg'), '<svg/>');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app?.inject({ method: 'GET', url, headers: { host, ...headers } });

describe('static web app', () => {
  beforeEach(async () => {
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false, webRoot: root });
  });

  it('serves index.html at /', async () => {
    const res = await get('/');
    expect(res?.statusCode).toBe(200);
    expect(res?.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res?.headers['cache-control']).toBe('no-cache');
    expect(res?.body).toBe(INDEX);
  });

  it('serves hashed assets as immutable', async () => {
    const res = await get('/assets/app-3f9a.js');
    expect(res?.statusCode).toBe(200);
    expect(res?.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res?.headers['cache-control']).toContain('immutable');
    expect(res?.body).toBe('console.log(1)');
  });

  it('serves other files with their type', async () => {
    const res = await get('/favicon.svg');
    expect(res?.headers['content-type']).toBe('image/svg+xml');
  });

  it('falls back to index.html for client routes', async () => {
    for (const url of ['/projects/acme-shop', '/sessions/abc?tab=diff', '/settings/']) {
      const res = await get(url);
      expect(res?.statusCode, url).toBe(200);
      expect(res?.body, url).toBe(INDEX);
    }
  });

  it('returns 404 for missing files with an extension', async () => {
    expect((await get('/assets/missing.js'))?.statusCode).toBe(404);
  });

  it('never serves the SPA for server paths', async () => {
    expect((await get('/api/nope', { 'x-cboard-token': token }))?.statusCode).toBe(404);
    expect((await get('/api/nope'))?.statusCode).toBe(401);
    expect((await get('/ws/other'))?.statusCode).toBe(404);
    expect((await get('/api/health'))?.json()).toMatchObject({ ok: true });
  });

  it('refuses path traversal', async () => {
    for (const url of ['/../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fx.js']) {
      const res = await get(url);
      expect(res?.statusCode, url).not.toBe(500);
      expect(res?.body, url).not.toContain('"name"');
    }
  });

  it('still enforces the Host allowlist', async () => {
    const res = await app?.inject({ method: 'GET', url: '/', headers: { host: 'evil.test' } });
    expect(res?.statusCode).toBe(403);
  });
});

describe('without a web build', () => {
  it('registers nothing and leaves unknown routes as 404', async () => {
    await rm(join(root, 'index.html'));
    app = await buildServer(config, { token, dbPath: ':memory:', processes: false, webRoot: root });
    expect((await get('/'))?.statusCode).toBe(404);
  });
});

describe('resolveAssetPath', () => {
  it('keeps paths inside the root', () => {
    expect(resolveAssetPath('/srv/web', '/assets/a.js')).toBe('/srv/web/assets/a.js');
    expect(resolveAssetPath('/srv/web', '/')).toBe('/srv/web');
  });

  it('rejects escapes, NULs, backslashes and bad encodings', () => {
    expect(resolveAssetPath('/srv/web', '/../etc/passwd')).toBeUndefined();
    expect(resolveAssetPath('/srv/web', '/%2e%2e/x')).toBeUndefined();
    expect(resolveAssetPath('/srv/web', '/a%00.js')).toBeUndefined();
    expect(resolveAssetPath('/srv/web', '/..%5c..%5cx')).toBeUndefined();
    expect(resolveAssetPath('/srv/web', '/%E0%A4%A')).toBeUndefined();
    expect(resolveAssetPath('/srv/web', '/../web-other/x')).toBeUndefined();
  });
});
