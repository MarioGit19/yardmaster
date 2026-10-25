import { PAIRING_CODE_TTL_MS } from '@yardmaster/protocol';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { buildServer, startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { EDITOR_WS_PATH } from './editor-gateway.js';
import { DEVICE_COOKIE, deviceName, RemoteDevices, remoteHosts } from './remote.js';
import { TOKEN_HEADER } from './security.js';
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

/** Pairs a phone and returns its device cookie (`name=value`). */
async function pair(instance: FastifyInstance): Promise<string> {
  const res = await call(instance, 'GET', await pairingPath(instance), {
    ...remote,
    'user-agent': IPHONE_UA,
  });
  expect(res.statusCode).toBe(302);
  const header = String(res.headers['set-cookie']);
  return header.split(';', 1)[0] ?? '';
}

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
    expect(auth.headers['set-cookie']).toBeUndefined();
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

describe('pairing', () => {
  it('signs a phone in with a one-time code and a Secure device cookie', async () => {
    const instance = await server();
    const path = await pairingPath(instance);
    const res = await call(instance, 'GET', path, { ...remote, 'user-agent': IPHONE_UA });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const header = String(res.headers['set-cookie']);
    expect(header).toMatch(new RegExp(`^${DEVICE_COOKIE}=`));
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) {
      expect(header).toContain(attr);
    }
    const cookie = header.split(';', 1)[0] ?? '';
    const settings = await call(instance, 'GET', '/api/settings', { ...remote, cookie });
    expect(settings.statusCode).toBe(200);
    // The device cookie is for the phone's host only, not for the local board.
    const onLocal = await instance.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { ...local, cookie },
    });
    expect(onLocal.statusCode).toBe(401);
  });

  it('keeps a phone paired before the rename signed in and moves its cookie', async () => {
    const instance = await server();
    const value = (await pair(instance)).split('=')[1] ?? '';
    const cookie = `cboard_device=${value}`;
    const res = await call(instance, 'GET', '/api/settings', { ...remote, cookie });
    expect(res.statusCode).toBe(200);
    const set = [res.headers['set-cookie']].flat().map(String);
    expect(set[0]).toMatch(new RegExp(`^${DEVICE_COOKIE}=${value.replace('.', '\\.')};`));
    expect(set[0]).toContain('Secure');
    expect(set[1]).toMatch(/^cboard_device=;.*Max-Age=0/);
    // A forged old cookie gets nothing, and no new cookie.
    const forged = await call(instance, 'GET', '/api/settings', {
      ...remote,
      cookie: 'cboard_device=forged.secret',
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.headers['set-cookie']).toBeUndefined();
  });

  it('spends a code on first use', async () => {
    const instance = await server();
    const path = await pairingPath(instance);
    expect((await call(instance, 'GET', path, remote)).statusCode).toBe(302);
    const again = await call(instance, 'GET', path, remote);
    expect(again.statusCode).toBe(401);
    expect(again.headers['set-cookie']).toBeUndefined();
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
    expect(late.headers['set-cookie']).toBeUndefined();
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
    expect((await call(instance, 'GET', path, remote)).statusCode).toBe(302);
  });

  it('keeps one live code: a new one replaces the last', async () => {
    const instance = await server();
    const first = await pairingPath(instance);
    const second = await pairingPath(instance);
    expect((await call(instance, 'GET', first, remote)).statusCode).toBe(401);
    expect((await call(instance, 'GET', second, remote)).statusCode).toBe(302);
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
    const cookie = await pair(instance);
    const fromPhone = await call(instance, 'POST', '/api/remote/pair', { ...remote, cookie }, {});
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
    const cookie = await pair(instance);
    const res = await call(instance, 'GET', '/api/remote/devices', { ...remote, cookie });
    const { devices } = res.json();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ name: 'iPhone · Safari', current: true });
    expect(Object.keys(devices[0]).sort()).toEqual(
      ['current', 'id', 'lastSeenAt', 'name', 'pairedAt'].sort(),
    );
    const fromMac = await call(instance, 'GET', '/api/remote/devices', local);
    expect(fromMac.json().devices[0].current).toBe(false);
  });

  it('can be revoked, which signs that device out and leaves the others', async () => {
    const instance = await server();
    const first = await pair(instance);
    const second = await pair(instance);
    const { devices } = (await call(instance, 'GET', '/api/remote/devices', local)).json();
    const firstId = first.split('=')[1]?.split('.')[0];
    expect(devices.map((d: { id: string }) => d.id)).toContain(firstId);

    const res = await call(instance, 'DELETE', `/api/remote/devices/${firstId}`, local);
    expect(res.statusCode).toBe(200);
    const revoked = await call(instance, 'GET', '/api/settings', { ...remote, cookie: first });
    expect(revoked.statusCode).toBe(401);
    const kept = await call(instance, 'GET', '/api/settings', { ...remote, cookie: second });
    expect(kept.statusCode).toBe(200);
    const unknown = await call(instance, 'DELETE', `/api/remote/devices/${firstId}`, local);
    expect(unknown.statusCode).toBe(404);
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
    const cookie = String(paired.headers['set-cookie']).split(';', 1)[0] ?? '';
    const id = cookie.split('=')[1]?.split('.')[0];

    const socket = new WebSocket(`ws://127.0.0.1:${port(app)}${UI_WS_PATH}`, {
      headers: { ...remote, origin: `https://${PHONE_HOST}`, cookie },
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

  it('persist across restarts', async () => {
    let saved: unknown = [];
    const make = () =>
      new RemoteDevices({
        load: () => saved,
        save: (devices) => {
          saved = structuredClone(devices);
        },
      });
    const devices = make();
    const { code } = devices.createCode();
    const result = devices.redeem(code, IPHONE_UA);
    if (!result.ok) throw new Error('expected a pairing');
    const restarted = make();
    expect(restarted.verify(result.cookie)).toBe(result.device.id);
    expect(restarted.verify(`${result.device.id}.wrong-secret`)).toBeNull();
    expect(restarted.verify('garbage')).toBeNull();
    expect(JSON.stringify(saved)).not.toContain(result.cookie.split('.')[1]);
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
