import { PAIRING_CODE_TTL_MS, REMOTE_SESSION_IDLE_MS, SESSION_HEADER } from '@yardmaster/protocol';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { buildServer, startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { EDITOR_WS_PATH } from './editor-gateway.js';
import { deviceName, LEGACY_DEVICES_KEY, remoteHosts } from './remote.js';
import { TOKEN_HEADER } from './security.js';
import { BrowserSessions } from './sessions.js';
import { generateToken } from './token.js';
import { UI_WS_PATH } from './ui-gateway.js';

const config: ServerConfig = {
  port: 4317,
  host: '127.0.0.1',
  home: '/home/dev/.yardmaster',
  logLevel: 'silent',
  devOrigins: [],
};
const token = generateToken();
const local = { host: '127.0.0.1:4317' };
const PHONE_HOST = 'dev-mac.tailnet-acme.ts.net';
const remote = { host: PHONE_HOST, 'x-forwarded-proto': 'https' };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let app: FastifyInstance | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});

async function server(hosts: string[] = [PHONE_HOST]): Promise<FastifyInstance> {
  app = await buildServer(config, { token, dbPath: ':memory:', processes: false, git: false });
  if (hosts.length > 0) {
    const res = await call(app, 'PUT', '/api/settings', local, { remoteAllowedHosts: hosts });
    expect(res.statusCode).toBe(200);
  }
  return app;
}

function call(
  instance: FastifyInstance,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  headers: InjectOptions['headers'],
  body?: unknown,
) {
  const auth = headers?.host === local.host ? { [TOKEN_HEADER]: token } : {};
  return instance.inject({
    method,
    url,
    headers: { ...auth, ...headers },
    ...(body === undefined ? {} : { payload: body as InjectOptions['payload'] }),
  });
}

/** Makes a pairing code on the Mac and returns its `/pair?c=` path. */
async function pairingPath(instance: FastifyInstance): Promise<string> {
  const res = await call(instance, 'POST', '/api/remote/pair', local, {});
  expect(res.statusCode).toBe(200);
  const url = new URL(res.json().url);
  expect(url.origin).toBe(`https://${PHONE_HOST}`);
  return `${url.pathname}${url.search}`;
}

/** The secret a pairing page hands to the phone's origin. */
function pageSecret(html: string): string {
  const match = /<meta name="yardmaster-session" content="([^"]+)">/.exec(html);
  if (!match?.[1]) throw new Error('expected a session page');
  return match[1];
}

/** Pairs a phone and returns its session header. */
async function pair(instance: FastifyInstance): Promise<Record<string, string>> {
  const res = await call(instance, 'GET', await pairingPath(instance), {
    ...remote,
    'user-agent': IPHONE_UA,
  });
  expect(res.statusCode).toBe(200);
  return { [SESSION_HEADER]: pageSecret(res.body) };
}

const idOf = (header: Record<string, string>) => header[SESSION_HEADER]?.split('.')[0];

describe('remote hosts', () => {
  it('are off by default', async () => {
    const instance = await server([]);
    const res = await call(instance, 'GET', '/api/health', remote);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_host' });
  });

  it('refuse a host that is not listed', async () => {
    const instance = await server();
    for (const host of ['other-mac.tailnet-acme.ts.net', 'dev-mac.tailnet-acme.ts.net.evil.test']) {
      const res = await call(instance, 'GET', '/api/health', { ...remote, host });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden_host' });
    }
  });

  it('accept a listed host over HTTPS, bare or with :443', async () => {
    const instance = await server();
    for (const host of [PHONE_HOST, `${PHONE_HOST}:443`, PHONE_HOST.toUpperCase()]) {
      const res = await call(instance, 'GET', '/api/health', { ...remote, host });
      expect(res.statusCode).toBe(200);
    }
  });

  it('refuse plain HTTP for a listed host', async () => {
    const instance = await server();
    for (const proto of [undefined, 'http', 'https, http']) {
      const res = await call(instance, 'GET', '/api/health', {
        host: PHONE_HOST,
        ...(proto ? { 'x-forwarded-proto': proto } : {}),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'https_required' });
    }
  });

  it('refuse an Origin other than the host over HTTPS', async () => {
    const instance = await server();
    for (const origin of [
      `http://${PHONE_HOST}`,
      'https://other-mac.tailnet-acme.ts.net',
      'http://127.0.0.1:4317',
    ]) {
      const res = await call(instance, 'GET', '/api/health', { ...remote, origin });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden_origin' });
    }
    const ok = await call(instance, 'GET', '/api/health', {
      ...remote,
      origin: `https://${PHONE_HOST}`,
    });
    expect(ok.statusCode).toBe(200);
  });

  it('never accept the token: not as a header and not through /auth', async () => {
    const instance = await server();
    const header = await call(instance, 'GET', '/api/settings', {
      ...remote,
      [TOKEN_HEADER]: token,
    });
    expect(header.statusCode).toBe(401);
    const auth = await call(instance, 'GET', `/auth?t=${token}`, remote);
    expect(auth.statusCode).toBe(403);
    expect(auth.json()).toEqual({ error: 'pair_required' });
    const code = instance.browserSessions.createSignInCode().code;
    const signIn = await call(instance, 'GET', `/auth?c=${code}`, remote);
    expect(signIn.statusCode).toBe(403);
    expect(instance.browserSessions.list()).toEqual([]);
  });

  it('never open the editor socket, even with the token', async () => {
    app = await startServer(
      { ...config, port: 0 },
      { token, dbPath: ':memory:', processes: false, git: false },
    );
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { host: `127.0.0.1:${port(app)}`, [TOKEN_HEADER]: token },
      payload: { remoteAllowedHosts: [PHONE_HOST] },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port(app)}${EDITOR_WS_PATH}`, {
      headers: { ...remote, [TOKEN_HEADER]: token },
    });
    sockets.push(socket);
    socket.on('error', () => {});
    const status = await new Promise<number | undefined>((resolve) => {
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      socket.once('open', () => resolve(undefined));
    });
    expect(status).toBe(403);
  });

  it('only accept *.ts.net names in the settings', async () => {
    const instance = await server([]);
    for (const hosts of [
      ['dev-mac.example.test'],
      ['ts.net'],
      ['tailnet-acme.ts.net'],
      ['https://dev-mac.tailnet-acme.ts.net'],
      ['dev-mac.tailnet-acme.ts.net:443'],
      ['a.b.ts.net', 'c.d.ts.net', 'e.f.ts.net', 'g.h.ts.net', 'i.j.ts.net'],
    ]) {
      const res = await call(instance, 'PUT', '/api/settings', local, {
        remoteAllowedHosts: hosts,
      });
      expect(res.statusCode).toBe(400);
    }
    const res = await call(instance, 'PUT', '/api/settings', local, {
      remoteAllowedHosts: ['Dev-Mac.Tailnet-Acme.ts.net ', PHONE_HOST],
    });
    expect(res.json().remoteAllowedHosts).toEqual([PHONE_HOST]);
  });
});

describe('forwarded requests', () => {
  /** What `tailscale serve` adds, sent with this machine's own Host. */
  const forwarded = {
    host: local.host,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.101.102.103',
  };

  it('count as remote whatever their Host: the token never signs them in', async () => {
    const instance = await server();
    for (const extra of [
      {},
      { 'tailscale-user-login': 'dev@example.test' },
      { 'x-forwarded-host': local.host },
    ]) {
      const res = await call(instance, 'GET', '/api/settings', { ...forwarded, ...extra });
      expect(res.statusCode).toBe(401);
    }
    const tailscaleOnly = await call(instance, 'GET', '/api/settings', {
      host: local.host,
      'x-forwarded-proto': 'https',
      'tailscale-user-login': 'dev@example.test',
    });
    expect(tailscaleOnly.statusCode).toBe(401);
    // A browser session on this machine doesn't count through the proxy either.
    const mac = instance.browserSessions.create('local', undefined);
    const session = await call(instance, 'GET', '/api/settings', {
      ...forwarded,
      [SESSION_HEADER]: mac.secret,
    });
    expect(session.statusCode).toBe(401);
    const auth = await call(instance, 'GET', '/auth?c=x', forwarded);
    expect(auth.json()).toEqual({ error: 'pair_required' });
  });

  it('need HTTPS and the phone’s origin, like a listed host', async () => {
    const instance = await server();
    const plain = await call(instance, 'GET', '/api/health', {
      host: local.host,
      'x-forwarded-for': '100.101.102.103',
    });
    expect(plain.json()).toEqual({ error: 'https_required' });
    const origin = await call(instance, 'GET', '/api/health', {
      ...forwarded,
      origin: 'http://127.0.0.1:4317',
    });
    expect(origin.json()).toEqual({ error: 'forbidden_origin' });
  });

  it('let a paired phone in, as a phone', async () => {
    const instance = await server();
    const phone = await pair(instance);
    const res = await call(instance, 'GET', '/api/settings', { ...forwarded, ...phone });
    expect(res.statusCode).toBe(200);
    const rotate = await call(
      instance,
      'POST',
      '/api/token/rotate',
      { ...forwarded, ...phone },
      {},
    );
    expect(rotate.statusCode).toBe(403);
    expect(rotate.json()).toEqual({ error: 'local_only' });
  });

  it('refuse Funnel, on any host', async () => {
    const instance = await server();
    const phone = await pair(instance);
    for (const headers of [{ ...remote, ...phone }, forwarded, { host: local.host }]) {
      const res = await call(instance, 'GET', '/api/health', {
        ...headers,
        'tailscale-funnel-request': '?1',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'funnel_unsupported' });
    }
  });

  it('leave this machine’s own requests local', async () => {
    const instance = await server();
    const res = await call(instance, 'POST', '/api/remote/pair', local, {});
    expect(res.statusCode).toBe(200);
  });
});

describe('a paired phone', () => {
  const LOCAL_ONLY: [method: 'PUT' | 'POST', url: string, body: unknown][] = [
    ['PUT', '/api/settings', { editorCli: '/usr/local/bin/cursor' }],
    ['PUT', '/api/settings', { editorCli: null }],
    ['PUT', '/api/settings', { libraryRoots: ['/home/dev/code'] }],
    ['PUT', '/api/settings', { remoteAllowedHosts: [] }],
    ['PUT', '/api/settings', { retentionDays: 1 }],
    ['PUT', '/api/settings', { awayMode: true, libraryRoots: [] }],
    ['POST', '/api/token/rotate', {}],
    ['POST', '/api/hooks/plan', {}],
    ['POST', '/api/hooks/install', { fingerprint: 'x' }],
    ['POST', '/api/remote/pair', {}],
  ];

  it.each(LOCAL_ONLY)('may not %s %s %j', async (method, url, body) => {
    const instance = await server();
    const phone = await pair(instance);
    const before = (await call(instance, 'GET', '/api/settings', local)).json();
    const res = await call(instance, method, url, { ...remote, ...phone }, body);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'local_only' });
    // Nothing changed, not even the allowed part of a mixed patch.
    expect((await call(instance, 'GET', '/api/settings', local)).json()).toEqual(before);
    expect(instance.browserSessions.list()).toHaveLength(1);
  });

  it('keeps its day-to-day settings: notifications, away mode, pins', async () => {
    const instance = await server();
    const phone = await pair(instance);
    const res = await call(
      instance,
      'PUT',
      '/api/settings',
      { ...remote, ...phone },
      {
        notifyEvents: ['needs_you'],
        notifyHideDetails: true,
        awayMode: true,
        awayTimeoutSec: 120,
        terminalReply: false,
        libraryIdleHideMin: 60,
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ notifyHideDetails: true, awayMode: true });
    const hooks = await call(instance, 'GET', '/api/hooks', { ...remote, ...phone });
    expect(hooks.statusCode).toBe(200);
  });

  it('may sign out only itself, as a session or a paired device', async () => {
    const instance = await server();
    const first = await pair(instance);
    const second = await pair(instance);
    const mac = instance.browserSessions.create('local', undefined);
    for (const url of [
      `/api/sessions/${mac.session.id}`,
      `/api/sessions/${idOf(second)}`,
      `/api/remote/devices/${idOf(second)}`,
    ]) {
      const res = await call(instance, 'DELETE', url, { ...remote, ...first });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'local_only' });
    }
    expect(instance.browserSessions.list()).toHaveLength(3);

    const self = await call(instance, 'DELETE', `/api/remote/devices/${idOf(first)}`, {
      ...remote,
      ...first,
    });
    expect(self.statusCode).toBe(200);
    const other = await call(instance, 'DELETE', `/api/sessions/${idOf(second)}`, {
      ...remote,
      ...second,
    });
    expect(other.statusCode).toBe(200);
    expect(instance.browserSessions.list().map((s) => s.id)).toEqual([mac.session.id]);
  });

  it('manages only its own notification subscriptions', async () => {
    const instance = await server();
    const first = await pair(instance);
    const second = await pair(instance);
    const subscribe = async (phone: Record<string, string>, n: number) => {
      const res = await call(
        instance,
        'POST',
        '/api/push/subscriptions',
        { ...remote, ...phone },
        {
          endpoint: `https://web.push.apple.com/QHx${n}`,
          keys: { p256dh: `BKey${n}`, auth: `auth${n}` },
        },
      );
      expect(res.statusCode).toBe(200);
      return (res.json() as { id: string }).id;
    };
    const mine = await subscribe(first, 1);
    const theirs = await subscribe(second, 2);
    const asFirst = { ...remote, ...first };
    // Re-sending another device's endpoint doesn't take its subscription over.
    const takeover = await call(instance, 'POST', '/api/push/subscriptions', asFirst, {
      endpoint: 'https://web.push.apple.com/QHx2',
      keys: { p256dh: 'BKeyX', auth: 'authX' },
    });
    expect(takeover.statusCode).toBe(403);
    expect(takeover.json()).toEqual({ error: 'local_only' });
    expect(instance.pushSubscriptions.get(theirs)).toMatchObject({ p256dh: 'BKey2' });
    expect(await subscribe(first, 1)).toBe(mine);
    for (const [method, url, body] of [
      ['DELETE', `/api/push/subscriptions/${theirs}`, undefined],
      ['POST', '/api/push/test', { id: theirs }],
    ] as const) {
      const res = await call(instance, method, url, asFirst, body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'local_only' });
    }
    expect(instance.pushSubscriptions.list()).toHaveLength(2);

    const own = await call(instance, 'DELETE', `/api/push/subscriptions/${mine}`, asFirst);
    expect(own.statusCode).toBe(200);
    // This machine manages every device's notifications.
    const mac = await call(instance, 'DELETE', `/api/push/subscriptions/${theirs}`, local);
    expect(mac.statusCode).toBe(200);
    expect(instance.pushSubscriptions.list()).toEqual([]);
  });

  it('never posts hook events or permission requests', async () => {
    const instance = await server();
    const phone = await pair(instance);
    for (const url of ['/api/hooks/claude', '/api/hooks/permission']) {
      const res = await call(instance, 'POST', url, { ...remote, ...phone }, {});
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'local_channel_required' });
    }
  });
});

describe('pairing', () => {
  it('signs a phone in with a one-time code, handing its secret to the phone’s origin', async () => {
    const instance = await server();
    const path = await pairingPath(instance);
    const res = await call(instance, 'GET', path, { ...remote, 'user-agent': IPHONE_UA });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    // The old device cookies are cleared; no new credential goes into a cookie.
    const set = [res.headers['set-cookie'] ?? []].flat().map(String);
    expect(set.some((c) => c.startsWith('yardmaster_device=;') && c.includes('Max-Age=0'))).toBe(
      true,
    );
    for (const cookie of set) expect(cookie).toMatch(/^\w+=; /);
    const phone = { [SESSION_HEADER]: pageSecret(res.body) };
    const settings = await call(instance, 'GET', '/api/settings', { ...remote, ...phone });
    expect(settings.statusCode).toBe(200);
    // The phone's session is for the phone's host only, not for the local board.
    const onLocal = await instance.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { ...local, ...phone },
    });
    expect(onLocal.statusCode).toBe(401);
  });

  it('signs nothing in with a device cookie from before per-browser sessions', async () => {
    const instance = await server();
    const phone = await pair(instance);
    const value = phone[SESSION_HEADER] as string;
    for (const cookie of [`yardmaster_device=${value}`, `cboard_device=${value}`]) {
      const res = await call(instance, 'GET', '/api/settings', { ...remote, cookie });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('drops the device list paired with cookies, so those phones pair again', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Persistence } = await import('./persistence.js');
    const home = await mkdtemp(join(tmpdir(), 'yardmaster-remote-'));
    try {
      const dbPath = join(home, 'board.db');
      const db = new Persistence({ home, path: dbPath });
      db.setSetting(LEGACY_DEVICES_KEY, [
        { id: 'old-phone-1', name: 'iPhone', hash: 'x', pairedAt: 1, lastSeenAt: 1 },
      ]);
      db.close();
      app = await buildServer({ ...config, home }, { token, dbPath, processes: false, git: false });
      expect(app.settings[LEGACY_DEVICES_KEY]).toBeUndefined();
      expect(app.browserSessions.list()).toEqual([]);
    } finally {
      await app?.close();
      app = undefined;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('spends a code on first use', async () => {
    const instance = await server();
    const path = await pairingPath(instance);
    expect((await call(instance, 'GET', path, remote)).statusCode).toBe(200);
    const again = await call(instance, 'GET', path, remote);
    expect(again.statusCode).toBe(401);
    expect(again.body).not.toContain('yardmaster-session');
    expect(again.body).toContain('already used');
  });

  it('refuses a code after five minutes, and spends it', async () => {
    const instance = await server();
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const path = await pairingPath(instance);
    now.mockReturnValue(start + PAIRING_CODE_TTL_MS + 1);
    const late = await call(instance, 'GET', path, remote);
    expect(late.statusCode).toBe(401);
    expect(late.body).not.toContain('yardmaster-session');
    expect(late.body).toContain('expired');
    now.mockReturnValue(start);
    expect((await call(instance, 'GET', path, remote)).statusCode).toBe(401);
  });

  it('accepts a code just before it expires', async () => {
    const instance = await server();
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const path = await pairingPath(instance);
    now.mockReturnValue(start + PAIRING_CODE_TTL_MS - 1);
    expect((await call(instance, 'GET', path, remote)).statusCode).toBe(200);
  });

  it('keeps one live code: a new one replaces the last', async () => {
    const instance = await server();
    const first = await pairingPath(instance);
    const second = await pairingPath(instance);
    expect((await call(instance, 'GET', first, remote)).statusCode).toBe(401);
    expect((await call(instance, 'GET', second, remote)).statusCode).toBe(200);
  });

  it('refuses wrong, missing and local codes', async () => {
    const instance = await server();
    await pairingPath(instance);
    expect((await call(instance, 'GET', '/pair?c=not-the-code', remote)).statusCode).toBe(401);
    expect((await call(instance, 'GET', '/pair', remote)).statusCode).toBe(401);
    const onLocal = await call(instance, 'GET', await pairingPath(instance), local);
    expect(onLocal.statusCode).toBe(403);
  });

  it('only makes codes on this machine, and only for a listed host', async () => {
    const instance = await server();
    const phone = await pair(instance);
    const fromPhone = await call(instance, 'POST', '/api/remote/pair', { ...remote, ...phone }, {});
    expect(fromPhone.statusCode).toBe(403);
    expect(fromPhone.json()).toEqual({ error: 'local_only' });
    const unlisted = await call(instance, 'POST', '/api/remote/pair', local, {
      host: 'other-mac.tailnet-acme.ts.net',
    });
    expect(unlisted.statusCode).toBe(409);
    const unauthenticated = await instance.inject({
      method: 'POST',
      url: '/api/remote/pair',
      headers: local,
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(401);
    await instance.close();

    const none = await server([]);
    const res = await call(none, 'POST', '/api/remote/pair', local, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_remote_host');
  });
});

describe('paired devices', () => {
  it('are listed without secrets, the calling one marked', async () => {
    const instance = await server();
    const phone = await pair(instance);
    const res = await call(instance, 'GET', '/api/remote/devices', { ...remote, ...phone });
    const { devices } = res.json();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ name: 'iPhone · Safari', current: true });
    expect(Object.keys(devices[0]).sort()).toEqual(
      ['current', 'id', 'lastSeenAt', 'name', 'pairedAt'].sort(),
    );
    const fromMac = await call(instance, 'GET', '/api/remote/devices', local);
    expect(fromMac.json().devices[0].current).toBe(false);
    // Browsers on this machine are sessions too, but not paired devices.
    instance.browserSessions.create('local', undefined);
    expect((await call(instance, 'GET', '/api/remote/devices', local)).json().devices).toHaveLength(
      1,
    );
  });

  it('can be revoked, which signs that device out and leaves the others', async () => {
    const instance = await server();
    const first = await pair(instance);
    const second = await pair(instance);
    const { devices } = (await call(instance, 'GET', '/api/remote/devices', local)).json();
    const firstId = idOf(first);
    expect(devices.map((d: { id: string }) => d.id)).toContain(firstId);

    const res = await call(instance, 'DELETE', `/api/remote/devices/${firstId}`, local);
    expect(res.statusCode).toBe(200);
    const revoked = await call(instance, 'GET', '/api/settings', { ...remote, ...first });
    expect(revoked.statusCode).toBe(401);
    const kept = await call(instance, 'GET', '/api/settings', { ...remote, ...second });
    expect(kept.statusCode).toBe(200);
    const unknown = await call(instance, 'DELETE', `/api/remote/devices/${firstId}`, local);
    expect(unknown.statusCode).toBe(404);
    // A browser on this machine isn't a paired device.
    const mac = instance.browserSessions.create('local', undefined);
    const notPhone = await call(instance, 'DELETE', `/api/remote/devices/${mac.session.id}`, local);
    expect(notPhone.statusCode).toBe(404);
  });

  it('revoking closes the device’s open board socket', async () => {
    app = await startServer(
      { ...config, port: 0 },
      { token, dbPath: ':memory:', processes: false, git: false },
    );
    const localHost = { host: `127.0.0.1:${port(app)}`, [TOKEN_HEADER]: token };
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: localHost,
      payload: { remoteAllowedHosts: [PHONE_HOST] },
    });
    const code = await app.inject({
      method: 'POST',
      url: '/api/remote/pair',
      headers: localHost,
      payload: {},
    });
    const url = new URL(code.json().url);
    const paired = await app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
      headers: remote,
    });
    const phone = { [SESSION_HEADER]: pageSecret(paired.body) };
    const id = idOf(phone);

    const socket = new WebSocket(`ws://127.0.0.1:${port(app)}${UI_WS_PATH}`, {
      headers: { ...remote, origin: `https://${PHONE_HOST}`, ...phone },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('message', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    await app.inject({ method: 'DELETE', url: `/api/remote/devices/${id}`, headers: localHost });
    expect(await closed).toBe(4401);
  });

  it('persist across restarts, without their secrets', async () => {
    let saved: unknown = [];
    const make = () =>
      new BrowserSessions({
        load: () => saved,
        save: (list) => {
          saved = structuredClone(list);
        },
      });
    const sessions = make();
    const { code } = sessions.createPairingCode();
    const result = sessions.redeemPairing(code, IPHONE_UA);
    if (!result.ok) throw new Error('expected a pairing');
    const restarted = make();
    expect(restarted.verify(result.secret, 'remote')).toBe(result.session.id);
    expect(restarted.verify(result.secret, 'local')).toBeNull();
    expect(restarted.verify(`${result.session.id}.wrong-secret`, 'remote')).toBeNull();
    expect(restarted.verify('garbage', 'remote')).toBeNull();
    expect(JSON.stringify(saved)).not.toContain(result.secret.split('.')[1]);
  });

  it('expire after 30 days unused, sliding with use', () => {
    let now = 1_700_000_000_000;
    const sessions = new BrowserSessions({ load: () => [], save: () => {}, now: () => now });
    const phone = sessions.create('remote', IPHONE_UA);
    const mac = sessions.create('local', undefined);
    now += REMOTE_SESSION_IDLE_MS - 60_000;
    expect(sessions.verify(phone.secret, 'remote')).toBe(phone.session.id);
    now += REMOTE_SESSION_IDLE_MS - 60_000;
    expect(sessions.verify(phone.secret, 'remote')).toBe(phone.session.id);
    now += REMOTE_SESSION_IDLE_MS + 1;
    expect(sessions.verify(phone.secret, 'remote')).toBeNull();
    expect(sessions.list().map((s) => s.id)).toEqual([mac.session.id]);
    // Sessions on this machine last until revoked.
    expect(sessions.verify(mac.secret, 'local')).toBe(mac.session.id);
  });

  it('slide with an open board, and close its socket once they lapse unused', () => {
    let now = 1_700_000_000_000;
    const sessions = new BrowserSessions({ load: () => [], save: () => {}, now: () => now });
    const phone = sessions.create('remote', IPHONE_UA);
    const socket = { close: vi.fn(), once: vi.fn() };
    sessions.track(phone.session.id, socket, 4401);
    // Messages on the open socket count as use.
    now += REMOTE_SESSION_IDLE_MS - 60_000;
    sessions.touch(phone.session.id);
    now += REMOTE_SESSION_IDLE_MS - 60_000;
    sessions.sweep();
    expect(socket.close).not.toHaveBeenCalled();
    // Idle past the limit: the sweep ends it without any request, and closes the socket.
    now += REMOTE_SESSION_IDLE_MS;
    sessions.touch(phone.session.id);
    sessions.sweep();
    expect(socket.close).toHaveBeenCalledWith(4401, 'signed_out');
    expect(sessions.list()).toEqual([]);
  });
});

function port(instance: FastifyInstance): number {
  const address = instance.server.address();
  if (address === null || typeof address !== 'object') throw new Error('not listening');
  return address.port;
}

describe('remoteHosts', () => {
  it('keeps only valid, distinct names', () => {
    expect(
      remoteHosts({ 'remote.allowedHosts': [PHONE_HOST, PHONE_HOST, 'evil.test', 42] }),
    ).toEqual([PHONE_HOST]);
    expect(remoteHosts({})).toEqual([]);
  });
});

describe('deviceName', () => {
  it.each([
    [IPHONE_UA, 'iPhone · Safari'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
      'iPhone · Chrome',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      'Android phone · Chrome',
    ],
    [undefined, 'Device'],
  ])('%s', (ua, name) => {
    expect(deviceName(ua)).toBe(name);
  });
});
