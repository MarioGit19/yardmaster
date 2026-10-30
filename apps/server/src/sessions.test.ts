import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SEEN_MARKS, SESSION_HEADER, WS_UNAUTHORIZED } from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './app.js';
import type { ServerConfig } from './config.js';
import { EDITOR_WS_PATH } from './editor-gateway.js';
import { localWebSocket } from './local-channel.test-helpers.js';
import { TOKEN_HEADER } from './security.js';
import { BrowserSessions, MAX_SESSIONS } from './sessions.js';
import { sessionHeader } from './sessions.test-helpers.js';
import { generateToken } from './token.js';
import { UI_WS_PATH } from './ui-gateway.js';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/140.0';

let app: FastifyInstance | undefined;
let home: string | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function boot(): Promise<{ app: FastifyInstance; port: number; token: string }> {
  // Short, so the socket path stays under the platform's limit.
  home = await mkdtemp(join(tmpdir(), 'ym-ses-'));
  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    home,
    logLevel: 'silent',
    devOrigins: [],
  };
  const token = generateToken();
  app = await startServer(config, {
    token,
    dbPath: join(home, 'board.db'),
    processes: false,
    git: false,
  });
  return { app, port: (app.server.address() as AddressInfo).port, token };
}

function opened(socket: WebSocket): Promise<void> {
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.once('error', reject);
  });
}

const closeCode = (socket: WebSocket) =>
  new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

describe('session routes', () => {
  it('list every signed-in browser without secrets, and revoke one', async () => {
    const { app, port } = await boot();
    const mine = sessionHeader(app, MAC_UA);
    const other = sessionHeader(app);
    const host = { host: `127.0.0.1:${port}` };
    const list = await app.inject({ url: '/api/sessions', headers: { ...host, ...mine } });
    expect(list.statusCode).toBe(200);
    const { sessions } = list.json() as { sessions: Record<string, unknown>[] };
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.current)).toMatchObject({ kind: 'local', name: 'Mac · Firefox' });
    expect(Object.keys(sessions[0] ?? {}).sort()).toEqual(
      ['createdAt', 'current', 'id', 'kind', 'lastSeenAt', 'name'].sort(),
    );
    expect(list.body).not.toContain((mine[SESSION_HEADER] as string).split('.')[1]);

    const otherId = (other[SESSION_HEADER] as string).split('.')[0];
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${otherId}`,
      headers: { ...host, ...mine },
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/sessions', headers: { ...host, ...other } })).statusCode,
    ).toBe(401);
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${otherId}`,
      headers: { ...host, ...mine },
    });
    expect(again.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/sessions', headers: host })).statusCode).toBe(401);
  });

  it('revoking a session closes its open board socket with 4401', async () => {
    const { app, port } = await boot();
    const session = sessionHeader(app);
    const socket = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, {
      headers: { origin: `http://127.0.0.1:${port}`, ...session },
    });
    await opened(socket);
    const closed = closeCode(socket);
    app.browserSessions.revoke((session[SESSION_HEADER] as string).split('.')[0] as string);
    expect(await closed).toBe(WS_UNAUTHORIZED);
  });
});

describe('token rotation', () => {
  it('closes every open board and editor socket, so they sign in again', async () => {
    const { app, port, token } = await boot();
    const origin = `http://127.0.0.1:${port}`;
    const mine = sessionHeader(app);
    const board = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, {
      headers: { origin, ...sessionHeader(app) },
    });
    const own = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, {
      headers: { origin, ...mine },
    });
    const state = app.localChannel.state;
    if (state?.kind !== 'listening') throw new Error('expected the local socket');
    const editor = localWebSocket(state.path, EDITOR_WS_PATH, { [TOKEN_HEADER]: token });
    await Promise.all([opened(board), opened(own), opened(editor)]);
    const closed = Promise.all([closeCode(board), closeCode(own), closeCode(editor)]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/token/rotate',
      headers: { host: `127.0.0.1:${port}`, ...mine },
    });
    expect(res.statusCode).toBe(200);
    expect(await closed).toEqual([WS_UNAUTHORIZED, WS_UNAUTHORIZED, WS_UNAUTHORIZED]);

    // The caller's browser reconnects with its fresh session; the old one is refused.
    const { session } = res.json() as { session: string };
    const back = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, {
      headers: { origin, [SESSION_HEADER]: session },
    });
    await opened(back);
    const stale = new WebSocket(`ws://127.0.0.1:${port}${UI_WS_PATH}`, {
      headers: { origin, ...mine },
    });
    sockets.push(stale);
    expect(await closeCode(stale)).toBe(WS_UNAUTHORIZED);
  });
});

describe('seen items', () => {
  it('belong to each browser and stay out of the session list', async () => {
    const { app, port } = await boot();
    const mac = sessionHeader(app, MAC_UA);
    const phone = sessionHeader(app);
    const host = { host: `127.0.0.1:${port}` };
    const post = await app.inject({
      method: 'POST',
      url: '/api/seen',
      headers: { ...host, ...mac },
      payload: { marks: { 's:one': 5 } },
    });
    expect(post.statusCode).toBe(200);
    const read = async (headers: Record<string, string>) =>
      (await app.inject({ url: '/api/seen', headers: { ...host, ...headers } })).json();
    expect((await read(mac)).marks).toEqual({ 's:one': 5 });
    expect((await read(phone)).marks).toEqual({});
    const list = await app.inject({ url: '/api/sessions', headers: { ...host, ...mac } });
    expect(list.body).not.toContain('s:one');
    await app.close();
  });

  it('rejects a bad update, and a caller with no browser session', async () => {
    const { app, port, token } = await boot();
    const host = { host: `127.0.0.1:${port}` };
    const bad = await app.inject({
      method: 'POST',
      url: '/api/seen',
      headers: { ...host, ...sessionHeader(app) },
      payload: { marks: { 's:one': 'soon' } },
    });
    expect(bad.statusCode).toBe(400);
    const bare = await app.inject({
      url: '/api/seen',
      headers: { ...host, [TOKEN_HEADER]: token },
    });
    expect(bare.statusCode).toBe(403);
    await app.close();
  });

  it('keeps the newest time for a key and drops the oldest past the cap', () => {
    const sessions = new BrowserSessions({ load: () => [], save: () => {} });
    const { id } = sessions.create('local', undefined).session;
    sessions.markSeen(id, { a: 10 });
    sessions.markSeen(id, { a: 3 });
    expect(sessions.seen(id)?.marks).toEqual({ a: 10 });
    const many = Object.fromEntries(
      Array.from({ length: MAX_SEEN_MARKS }, (_, i) => [`k${i}`, i + 100]),
    );
    sessions.markSeen(id, many);
    const marks = sessions.seen(id)?.marks ?? {};
    expect(Object.keys(marks)).toHaveLength(MAX_SEEN_MARKS);
    expect(marks.a).toBeUndefined();
  });
});

describe('BrowserSessions', () => {
  it('keeps several live sign-in codes, each single use', () => {
    const sessions = new BrowserSessions({ load: () => [], save: () => {} });
    const a = sessions.createSignInCode().code;
    const b = sessions.createSignInCode().code;
    expect(sessions.redeemSignIn(b, undefined).ok).toBe(true);
    expect(sessions.redeemSignIn(a, undefined).ok).toBe(true);
    expect(sessions.redeemSignIn(a, undefined)).toEqual({ ok: false, error: 'invalid' });
    // A pairing code never signs in a local browser, and the other way round.
    const pairing = sessions.createPairingCode().code;
    expect(sessions.redeemSignIn(pairing, undefined).ok).toBe(false);
    const signIn = sessions.createSignInCode().code;
    expect(sessions.redeemPairing(signIn, undefined).ok).toBe(false);
  });

  it('forgets live codes on rotation', () => {
    const sessions = new BrowserSessions({ load: () => [], save: () => {} });
    const code = sessions.createSignInCode().code;
    const pairing = sessions.createPairingCode().code;
    sessions.revokeAll();
    expect(sessions.redeemSignIn(code, undefined).ok).toBe(false);
    expect(sessions.redeemPairing(pairing, undefined).ok).toBe(false);
  });

  it('drops the least recently used session past the limit', () => {
    let now = 1_000;
    const sessions = new BrowserSessions({ load: () => [], save: () => {}, now: () => now });
    const ended: string[] = [];
    sessions.onRevoke((id) => ended.push(id));
    const first = sessions.create('local', undefined);
    for (let i = 1; i < MAX_SESSIONS; i++) {
      now += 1;
      sessions.create('local', undefined);
    }
    expect(sessions.list()).toHaveLength(MAX_SESSIONS);
    now += 1;
    sessions.create('local', undefined);
    expect(sessions.list()).toHaveLength(MAX_SESSIONS);
    expect(ended).toEqual([first.session.id]);
    expect(sessions.verify(first.secret, 'local')).toBeNull();
  });
});
