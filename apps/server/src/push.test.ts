import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushInfoResponse, PushOutboxResponse } from '@yardmaster/protocol';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './app.js';
import type { ServerConfig } from './config.js';
import { isPushServiceEndpoint, type PushSender, VAPID_FILE } from './push.js';
import { TOKEN_HEADER } from './security.js';
import { generateToken } from './token.js';

const token = generateToken();
const local = { host: '127.0.0.1:4317' };
const PHONE_HOST = 'dev-mac.tailnet-acme.ts.net';
const remote = { host: PHONE_HOST, 'x-forwarded-proto': 'https' };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const subscription = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  expirationTime: null,
  keys: { p256dh: `BKey${n}`, auth: `auth${n}` },
});

let app: FastifyInstance | undefined;
let home: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function server(
  options: { demo?: boolean; send?: PushSender } = {},
): Promise<FastifyInstance> {
  home = await mkdtemp(join(tmpdir(), 'yardmaster-push-'));
  const config: ServerConfig = {
    port: 4317,
    host: '127.0.0.1',
    home,
    logLevel: 'silent',
    devOrigins: [],
  };
  app = await buildServer(config, {
    token,
    dbPath: ':memory:',
    processes: false,
    git: false,
    transcripts: { loadHistory: null },
    ...(options.demo ? { demo: true } : {}),
    ...(options.send ? { push: { send: options.send } } : {}),
  });
  return app;
}

function call(
  instance: FastifyInstance,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  headers: InjectOptions['headers'] = local,
) {
  const auth = headers?.host === local.host ? { [TOKEN_HEADER]: token } : {};
  return instance.inject({
    method,
    url,
    headers: { ...auth, ...headers },
    ...(body === undefined ? {} : { payload: body as InjectOptions['payload'] }),
  });
}

describe('push routes', () => {
  it('need the token', async () => {
    const instance = await server();
    for (const [method, url] of [
      ['GET', '/api/push'],
      ['POST', '/api/push/subscriptions'],
      ['POST', '/api/push/test'],
      ['POST', '/api/approvals/a/decision'],
    ] as const) {
      const res = await instance.inject({ method, url, headers: local });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('generate the VAPID keys on first use, keep them 0600 in the data dir, and reuse them', async () => {
    const instance = await server();
    const first = PushInfoResponse.parse((await call(instance, 'GET', '/api/push')).json());
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const file = join(home ?? '', VAPID_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const again = PushInfoResponse.parse((await call(instance, 'GET', '/api/push')).json());
    expect(again.publicKey).toBe(first.publicKey);
  });

  it('subscribe a browser once per endpoint, list it without its keys, and remove it', async () => {
    const instance = await server();
    const res = await call(instance, 'POST', '/api/push/subscriptions', subscription(1), {
      ...local,
      'user-agent': IPHONE_UA,
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json();
    const again = await call(instance, 'POST', '/api/push/subscriptions', subscription(1));
    expect(again.json().id).toBe(id);

    const info = (await call(instance, 'GET', '/api/push')).json();
    expect(info.devices).toEqual([
      { id, name: expect.any(String), createdAt: expect.any(Number), lastSentAt: null },
    ]);
    expect(JSON.stringify(info)).not.toContain('fcm.googleapis.com');

    expect((await call(instance, 'DELETE', `/api/push/subscriptions/${id}`)).statusCode).toBe(200);
    expect((await call(instance, 'DELETE', `/api/push/subscriptions/${id}`)).statusCode).toBe(404);
    expect((await call(instance, 'GET', '/api/push')).json().devices).toEqual([]);
  });

  it('refuse endpoints that are not a browser push service', async () => {
    const instance = await server();
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://127.0.0.1/push',
      'https://localhost:8443/push',
      'https://fcm.googleapis.com.evil.test/x',
      'not a url',
    ]) {
      const res = await call(instance, 'POST', '/api/push/subscriptions', {
        ...subscription(1),
        endpoint,
      });
      expect([400, 422], endpoint).toContain(res.statusCode);
    }
    expect(isPushServiceEndpoint('https://web.push.apple.com/QGx')).toBe(true);
    expect(isPushServiceEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(
      true,
    );
    expect(isPushServiceEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushServiceEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
  });

  it('send the test push, and drop a subscription that is gone (410)', async () => {
    const send = vi.fn<PushSender>(async () => ({ ok: true }));
    const instance = await server({ send });
    const { id } = (
      await call(instance, 'POST', '/api/push/subscriptions', subscription(1))
    ).json();
    const res = await call(instance, 'POST', '/api/push/test', { id });
    expect(res.statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
      expect.objectContaining({ type: 'show', kind: 'test' }),
      { urgency: 'normal' },
    );

    send.mockResolvedValueOnce({ ok: false, gone: true, status: 410 });
    const gone = await call(instance, 'POST', '/api/push/test', { id });
    expect(gone.statusCode).toBe(410);
    expect((await call(instance, 'GET', '/api/push')).json().devices).toEqual([]);
    expect((await call(instance, 'POST', '/api/push/test', { id })).statusCode).toBe(404);
  });

  it('report a push service failure without dropping the subscription', async () => {
    const instance = await server({ send: async () => ({ ok: false, gone: false, status: 503 }) });
    const { id } = (
      await call(instance, 'POST', '/api/push/subscriptions', subscription(1))
    ).json();
    expect((await call(instance, 'POST', '/api/push/test', { id })).statusCode).toBe(502);
    expect((await call(instance, 'GET', '/api/push')).json().devices).toHaveLength(1);
  });

  it('decide an approval from a notification action, on the Attention Center’s path', async () => {
    const instance = await server();
    const res = await call(instance, 'POST', '/api/approvals/nope/decision', { decision: 'allow' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'unknown_approval' });
    const bad = await call(instance, 'POST', '/api/approvals/nope/decision', { decision: 'maybe' });
    expect(bad.statusCode).toBe(400);
    // A notification never writes a rule: Allow once and Deny only.
    const always = await call(instance, 'POST', '/api/approvals/nope/decision', {
      decision: 'allowAlways',
    });
    expect(always.statusCode).toBe(400);
  });

  it('drop a paired device’s subscriptions when it is revoked', async () => {
    const instance = await server();
    await call(instance, 'PUT', '/api/settings', { remoteAllowedHosts: [PHONE_HOST] });
    const pairing = new URL((await call(instance, 'POST', '/api/remote/pair', {})).json().url);
    const paired = await call(instance, 'GET', `${pairing.pathname}${pairing.search}`, undefined, {
      ...remote,
      'user-agent': IPHONE_UA,
    });
    const secret = /name="yardmaster-session" content="([^"]+)"/.exec(paired.body)?.[1] ?? '';
    const phone = { ...remote, 'x-yardmaster-session': secret, 'user-agent': IPHONE_UA };
    const sub = await call(instance, 'POST', '/api/push/subscriptions', subscription(1), phone);
    expect(sub.statusCode).toBe(200);
    await call(instance, 'POST', '/api/push/subscriptions', subscription(2));
    expect((await call(instance, 'GET', '/api/push')).json().devices).toHaveLength(2);

    const [device] = (await call(instance, 'GET', '/api/remote/devices')).json().devices;
    await call(instance, 'DELETE', `/api/remote/devices/${device.id}`);
    const left = (await call(instance, 'GET', '/api/push')).json().devices;
    expect(left).toHaveLength(1);
    expect(left[0].id).not.toBe(sub.json().id);
  });

  it('belong to the browser session that added them, and end with it', async () => {
    const instance = await server();
    const mac = instance.browserSessions.create('local', undefined);
    const sub = await call(instance, 'POST', '/api/push/subscriptions', subscription(1), {
      host: '127.0.0.1:4317',
      'x-yardmaster-session': mac.secret,
    });
    expect(sub.statusCode).toBe(200);
    expect(instance.pushSubscriptions.list()[0]?.deviceId).toBe(mac.session.id);
    instance.browserSessions.revoke(mac.session.id);
    expect(instance.pushSubscriptions.list()).toEqual([]);
  });

  it('save the notification settings with the board settings', async () => {
    const instance = await server();
    const before = (await call(instance, 'GET', '/api/settings')).json();
    expect(before).toMatchObject({
      notifyEvents: ['needs_you', 'claude_finished', 'command_finished', 'crashed'],
      notifyHideDetails: false,
      notifyMutedProjects: [],
    });
    const res = await call(instance, 'PUT', '/api/settings', {
      notifyEvents: ['needs_you', 'background'],
      notifyHideDetails: true,
      notifyMutedProjects: ['proj-a', 'proj-a'],
    });
    expect(res.json()).toMatchObject({
      notifyEvents: ['needs_you', 'background'],
      notifyHideDetails: true,
      notifyMutedProjects: ['proj-a'],
    });
    const bad = await call(instance, 'PUT', '/api/settings', { notifyEvents: ['everything'] });
    expect(bad.statusCode).toBe(400);
  });

  it('serve the outbox and the drill in demo mode only', async () => {
    const real = await server();
    expect((await call(real, 'GET', '/api/push/outbox')).statusCode).toBe(404);
    expect((await call(real, 'POST', '/api/push/drill', {})).statusCode).toBe(404);
    await real.close();
    app = undefined;

    const demo = await server({ demo: true });
    // The demo's push service is simulated: any https endpoint will do.
    const { id } = (
      await call(demo, 'POST', '/api/push/subscriptions', {
        ...subscription(1),
        endpoint: 'https://push.example.test/e2e',
      })
    ).json();
    await call(demo, 'PUT', '/api/settings', {
      notifyEvents: ['needs_you', 'claude_finished', 'command_finished', 'crashed', 'background'],
    });
    expect((await call(demo, 'POST', '/api/push/drill', {})).statusCode).toBe(200);
    const { sent } = PushOutboxResponse.parse((await call(demo, 'GET', '/api/push/outbox')).json());
    const shows = sent.flatMap((s) => (s.payload.type === 'show' ? [s.payload] : []));
    expect(sent.every((s) => s.subscriptionId === id)).toBe(true);
    expect(shows.map((s) => s.kind).sort()).toEqual([
      'background',
      'claude_finished',
      'command_finished',
      'crashed',
      'needs_you',
    ]);
    expect(shows.map((s) => s.title)).toContain('drill-needs · Claude wants to run Bash');
    // The drill cleans up after itself.
    expect(Object.keys(demo.store.state.projects).some((p) => p.startsWith('drill-'))).toBe(false);
  });
});
