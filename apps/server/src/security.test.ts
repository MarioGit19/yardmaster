import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, startServer } from './app.js';
import type { ServerConfig } from './config.js';
import {
  createSessionValue,
  readCookie,
  registerSecurity,
  SESSION_COOKIE,
  TOKEN_HEADER,
  verifySessionValue,
} from './security.js';
import { generateToken } from './token.js';

const config: ServerConfig = {
  port: 4317,
  host: '127.0.0.1',
  home: '/home/dev/.yardmaster',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const host = '127.0.0.1:4317';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server(overrides: Partial<ServerConfig> = {}): Promise<FastifyInstance> {
  app = await buildServer(
    { ...config, ...overrides },
    { token, dbPath: ':memory:', processes: false },
  );
  return app;
}

/** A bare app with the security layer and protected probe routes (real ones come later). */
async function withProbe(): Promise<FastifyInstance> {
  app = Fastify();
  registerSecurity(app, { config, token });
  app.get('/api/probe', async (request) => ({ authorized: request.isAuthorized() }));
  app.post('/api/probe', async () => ({ ok: true }));
  await app.ready();
  return app;
}

function get(instance: FastifyInstance, url: string, headers: InjectOptions['headers'] = {}) {
  return instance.inject({ method: 'GET', url, headers: { host, ...headers } });
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error('expected a Set-Cookie header');
  return header.split(';', 1)[0] ?? '';
}

describe('Host allowlist', () => {
  it.each(['127.0.0.1:4317', 'localhost:4317', 'LOCALHOST:4317'])('accepts %s', async (h) => {
    const res = await get(await server(), '/api/health', { host: h });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    'evil.example.test:4317',
    'evil.example.test',
    '127.0.0.1',
    '127.0.0.1:4318',
    'localhost:80',
    '0.0.0.0:4317',
  ])('rejects %s with 403', async (h) => {
    const res = await get(await server(), '/api/health', { host: h });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_host' });
  });

  it('rejects a wrong Host even with a valid token', async () => {
    const res = await get(await server(), '/api/health', {
      host: 'rebind.example.test:4317',
      [TOKEN_HEADER]: token,
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a wrong Host on /auth', async () => {
    const res = await get(await server(), `/auth?t=${token}`, { host: 'rebind.example.test:4317' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the bracketed IPv6 host when bound to ::1', async () => {
    const res = await get(await server({ host: '::1' }), '/api/health', { host: '[::1]:4317' });
    expect(res.statusCode).toBe(200);
  });

  it('uses the real port when listening on an ephemeral one', async () => {
    app = await startServer(
      { ...config, port: 0 },
      { token, dbPath: ':memory:', processes: false },
    );
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    const ok = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(ok.status).toBe(200);
    const res = await get(app, '/api/health', { host: '127.0.0.1:0' });
    expect(res.statusCode).toBe(403);
  });
});

describe('Origin check', () => {
  it('rejects a cross-origin request with 403', async () => {
    const res = await get(await server(), '/api/health', { origin: 'http://evil.example.test' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_origin' });
  });

  it.each(['null', 'http://127.0.0.1:4318', 'https://127.0.0.1:4317', 'http://localhost:5173'])(
    'rejects origin %s even with a valid token',
    async (origin) => {
      const res = await get(await server(), '/api/health', { origin, [TOKEN_HEADER]: token });
      expect(res.statusCode).toBe(403);
    },
  );

  it.each(['http://127.0.0.1:4317', 'http://localhost:4317'])(
    'accepts the board origin %s',
    async (origin) => {
      const res = await get(await server(), '/api/health', { origin });
      expect(res.statusCode).toBe(200);
    },
  );

  it('accepts a configured dev origin and its Host', async () => {
    const instance = await server({ devOrigins: ['http://localhost:5173'] });
    const res = await get(instance, '/api/health', {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('API auth guard', () => {
  it('leaves /api/health public', async () => {
    const res = await get(await server(), '/api/health');
    expect(res.statusCode).toBe(200);
  });

  it('forbids framing on every response, refused ones too', async () => {
    const instance = await server();
    for (const res of [
      await get(instance, '/api/health'),
      await get(instance, '/api/settings'),
      await get(instance, '/api/health', { host: 'evil.example:4317' }),
    ]) {
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    }
  });

  it('returns 401 without a token', async () => {
    const res = await get(await withProbe(), '/api/probe');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 for a wrong token header', async () => {
    const res = await get(await withProbe(), '/api/probe', { [TOKEN_HEADER]: generateToken() });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a POST without a token', async () => {
    const res = await (await withProbe()).inject({
      method: 'POST',
      url: '/api/probe',
      headers: { host, 'content-type': 'application/json' },
      payload: { hook_event_name: 'Stop' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the X-Yardmaster-Token header', async () => {
    const res = await get(await withProbe(), '/api/probe', { [TOKEN_HEADER]: token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authorized: true });
  });

  it('accepts the old X-CBoard-Token header and session cookie for one version', async () => {
    const instance = await withProbe();
    const byHeader = await get(instance, '/api/probe', { 'x-cboard-token': token });
    expect(byHeader.json()).toEqual({ authorized: true });
    const wrong = await get(instance, '/api/probe', { 'x-cboard-token': generateToken() });
    expect(wrong.statusCode).toBe(401);
    const byCookie = await get(instance, '/api/probe', {
      cookie: `cboard_session=${createSessionValue(token)}`,
    });
    expect(byCookie.json()).toEqual({ authorized: true });
  });

  it('guards percent-encoded variants of /api routes', async () => {
    const instance = await withProbe();
    for (const url of ['/%61pi/probe', '/api/%70robe', '/api/probe?x=1']) {
      const res = await get(instance, url);
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('rejects a forged or stale session cookie', async () => {
    const instance = await withProbe();
    const forged = `${SESSION_COOKIE}=${createSessionValue(generateToken())}`;
    expect((await get(instance, '/api/probe', { cookie: forged })).statusCode).toBe(401);
    expect(
      (await get(instance, '/api/probe', { cookie: `${SESSION_COOKIE}=garbage` })).statusCode,
    ).toBe(401);
    const valid = `${SESSION_COOKIE}=${createSessionValue(token)}`;
    expect((await get(instance, '/api/probe', { cookie: valid })).json()).toEqual({
      authorized: true,
    });
  });
});

describe('/auth cookie flow', () => {
  it('sets a signed HttpOnly SameSite=Strict cookie and redirects to /', async () => {
    const instance = await server();
    const res = await get(instance, `/auth?t=${token}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    // The cookie is derived from the token, never the token itself.
    expect(setCookie).not.toContain(token);

    const cookie = sessionCookie(res.headers['set-cookie']);
    const authed = await get(instance, '/api/nope', { cookie: `theme=dark; ${cookie}` });
    // Authorized, so the request reaches routing (404) instead of the guard (401).
    expect(authed.statusCode).toBe(404);
  });

  it('rejects a wrong or missing token without setting a cookie', async () => {
    const instance = await server();
    for (const url of [`/auth?t=${generateToken()}`, '/auth', '/auth?t=', '/auth?t=a&t=b']) {
      const res = await get(instance, url);
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['set-cookie'], url).toBeUndefined();
    }
  });

  it('redirects an already authenticated browser without a token', async () => {
    const instance = await server();
    const cookie = sessionCookie((await get(instance, `/auth?t=${token}`)).headers['set-cookie']);
    const res = await get(instance, '/auth', { cookie });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('invalidates cookies when the token changes', async () => {
    const cookie = createSessionValue(token);
    expect(verifySessionValue(token, cookie)).toBe(true);
    expect(verifySessionValue(generateToken(), cookie)).toBe(false);
    expect(verifySessionValue(token, `${cookie}.extra`)).toBe(false);
    expect(verifySessionValue(token, `.${cookie}`)).toBe(false);
  });
});

describe('readCookie', () => {
  it('finds a cookie among others', () => {
    expect(readCookie('a=1; yardmaster_session=x.y; b=2', SESSION_COOKIE)).toBe('x.y');
    expect(readCookie('xyardmaster_session=nope', SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});
