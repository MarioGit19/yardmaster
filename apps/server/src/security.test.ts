import { SESSION_HEADER } from '@yardmaster/protocol';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { registerSecurity, signInUrl, TOKEN_HEADER } from './security.js';
import { BrowserSessions } from './sessions.js';
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
let probeSessions: BrowserSessions;

async function withProbe(): Promise<FastifyInstance> {
  app = Fastify();
  probeSessions = new BrowserSessions({ load: () => [], save: () => {} });
  registerSecurity(app, { config, token, sessions: probeSessions });
  app.get('/api/probe', async (request) => ({ authorized: request.isAuthorized() }));
  app.post('/api/probe', async () => ({ ok: true }));
  await app.ready();
  return app;
}

function get(instance: FastifyInstance, url: string, headers: InjectOptions['headers'] = {}) {
  return instance.inject({ method: 'GET', url, headers: { host, ...headers } });
}

/** The secret a sign-in page hands to the board's origin. */
function pageSecret(html: string): string {
  const match = /<meta name="yardmaster-session" content="([^"]+)">/.exec(html);
  if (!match?.[1]) throw new Error('expected a session page');
  return match[1];
}

/** A one-time sign-in code, as `yardmaster start` mints it. */
function signInCode(instance: FastifyInstance): string {
  return instance.browserSessions.createSignInCode().code;
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
    const instance = await server();
    const res = await get(instance, `/auth?c=${signInCode(instance)}`, {
      host: 'rebind.example.test:4317',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('yardmaster-session');
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

  it('accepts the old X-CBoard-Token header for one version, but no cookie', async () => {
    const instance = await withProbe();
    const byHeader = await get(instance, '/api/probe', { 'x-cboard-token': token });
    expect(byHeader.json()).toEqual({ authorized: true });
    const wrong = await get(instance, '/api/probe', { 'x-cboard-token': generateToken() });
    expect(wrong.statusCode).toBe(401);
  });

  it('guards percent-encoded variants of /api routes', async () => {
    const instance = await withProbe();
    for (const url of ['/%61pi/probe', '/api/%70robe', '/api/probe?x=1']) {
      const res = await get(instance, url);
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('accepts a live session header and refuses a forged, revoked or remote one', async () => {
    const instance = await withProbe();
    const local = probeSessions.create('local', undefined);
    const ok = await get(instance, '/api/probe', { [SESSION_HEADER]: local.secret });
    expect(ok.json()).toEqual({ authorized: true });

    const [id] = local.secret.split('.');
    for (const forged of [`${id}.${generateToken()}`, 'garbage', `${local.secret}x`, '']) {
      expect((await get(instance, '/api/probe', { [SESSION_HEADER]: forged })).statusCode).toBe(
        401,
      );
    }
    // A phone's session counts only over Tailscale.
    const phone = probeSessions.create('remote', undefined);
    expect((await get(instance, '/api/probe', { [SESSION_HEADER]: phone.secret })).statusCode).toBe(
      401,
    );
    probeSessions.revoke(local.session.id);
    expect((await get(instance, '/api/probe', { [SESSION_HEADER]: local.secret })).statusCode).toBe(
      401,
    );
  });

  it('ignores every cookie: a browser sends the board’s host cookies to any port', async () => {
    const instance = await withProbe();
    const secret = probeSessions.create('local', undefined).secret;
    const cookie = [
      `yardmaster_session=${secret}`,
      `cboard_session=${secret}`,
      `yardmaster_device=${secret}`,
      `${SESSION_HEADER}=${secret}`,
      'theme=dark',
    ].join('; ');
    const res = await get(instance, '/api/probe', { cookie });
    expect(res.statusCode).toBe(401);
  });
});

describe('sessionSecretOf', () => {
  it('reads the subprotocol only on a WebSocket upgrade', async () => {
    const instance = await withProbe();
    const secret = probeSessions.create('local', undefined).secret;
    const protocols = `yardmaster, yardmaster.session.${secret}`;
    const plain = await get(instance, '/api/probe', { 'sec-websocket-protocol': protocols });
    expect(plain.statusCode).toBe(401);
  });
});

describe('/auth one-time sign-in', () => {
  it('spends a code once and hands the secret to the page, never in a cookie or URL', async () => {
    const instance = await server();
    const code = signInCode(instance);
    const res = await get(instance, `/auth?c=${code}`, {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers.location).toBeUndefined();
    // Only expired old cookies, never a credential.
    for (const cookie of [res.headers['set-cookie'] ?? []].flat()) {
      expect(cookie).toMatch(/^\w+=; .*Max-Age=0$/);
    }
    const secret = pageSecret(res.body);
    expect(res.body).not.toContain(token);
    expect(res.body).toContain('localStorage.setItem("yardmaster.session"');

    const authed = await get(instance, '/api/nope', { [SESSION_HEADER]: secret });
    // Authorized, so the request reaches routing (404) instead of the guard (401).
    expect(authed.statusCode).toBe(404);
    expect(instance.browserSessions.list()).toMatchObject([
      { kind: 'local', name: 'Mac · Chrome' },
    ]);

    const again = await get(instance, `/auth?c=${code}`);
    expect(again.statusCode).toBe(401);
    expect(again.body).toContain('already used');
    expect(again.body).not.toContain('yardmaster-session');
  });

  it('refuses an expired code', async () => {
    let now = 1_000_000;
    const sessions = new BrowserSessions({ load: () => [], save: () => {}, now: () => now });
    const { code } = sessions.createSignInCode();
    now += 5 * 60 * 1000 + 1;
    expect(sessions.redeemSignIn(code, undefined)).toEqual({ ok: false, error: 'expired' });
    // Spent anyway.
    expect(sessions.redeemSignIn(code, undefined)).toEqual({ ok: false, error: 'invalid' });
  });

  it('never signs in with the install token: `?t=` shows the new-link page', async () => {
    const instance = await server();
    for (const url of [`/auth?t=${token}`, `/auth?t=${generateToken()}`, '/auth?t=']) {
      const res = await get(instance, url);
      expect(res.statusCode, url).toBe(410);
      expect(res.body).toContain('Use the new sign-in link');
      expect(res.body).toContain('yardmaster open');
      expect(res.body).not.toContain('yardmaster-session');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(instance.browserSessions.list()).toEqual([]);
  });

  it('refuses a missing, wrong or doubled code', async () => {
    const instance = await server();
    signInCode(instance);
    for (const url of ['/auth', `/auth?c=${generateToken()}`, '/auth?c=a&c=b']) {
      const res = await get(instance, url);
      expect([400, 401], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain('yardmaster-session');
    }
    expect(instance.browserSessions.list()).toEqual([]);
  });

  it('builds the link on the board, or on the dev server in dev', () => {
    expect(signInUrl(config, 4317, 'abc')).toBe('http://127.0.0.1:4317/auth?c=abc');
    expect(signInUrl({ ...config, devOrigins: ['http://127.0.0.1:4327'] }, 4317, 'a+b')).toBe(
      'http://127.0.0.1:4327/auth?c=a%2Bb',
    );
  });
});
