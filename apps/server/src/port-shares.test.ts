import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { PortBinding } from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './app.js';
import type { ServerConfig } from './config.js';
import {
  createTailscaleCli,
  PortShares,
  type PortSharesOptions,
  probeViteBlock,
  servedPorts,
} from './port-shares.js';
import { TOKEN_HEADER } from './security.js';
import { BoardStore } from './store.js';
import { generateToken } from './token.js';

const T0 = 1_760_000_000_000;
const DNS = 'dev-box.tailnet-test.ts.net';
const BOARD_PORT = 4317;

/**
 * A stand-in `tailscale` on PATH: it keeps a serve config in a JSON file, logs every call, and
 * starts with the board's own entry (443 → 4317) and one the user made (8080).
 */
const STUB = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.TS_STUB_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
save();
if (args[0] === 'status' && args[1] === '--json') {
  process.stdout.write(JSON.stringify({ BackendState: state.backend, Self: { DNSName: state.dnsName } }));
  process.exit(0);
}
if (args[0] === 'serve' && args[1] === 'status') {
  const host = state.dnsName.replace(/\\.$/, '');
  const tcp = {}, web = {};
  for (const [port, target] of Object.entries(state.serve)) {
    tcp[port] = { HTTPS: true };
    web[host + ':' + port] = { Handlers: { '/': { Proxy: target } } };
  }
  process.stdout.write(JSON.stringify({ TCP: tcp, Web: web }));
  process.exit(0);
}
if (args[0] === 'serve') {
  const port = (args.find((a) => a.startsWith('--https=')) || '').slice(8);
  if (args.includes('off')) {
    if (!state.serve[port]) { process.stderr.write('error: handler does not exist'); process.exit(1); }
    delete state.serve[port];
    save();
    process.exit(0);
  }
  if (state.failServe) { process.stderr.write(state.failServe); process.exit(1); }
  state.serve[port] = args[args.length - 1];
  save();
  process.stdout.write('Available within your tailnet\\n');
  process.exit(0);
}
process.stderr.write('unknown command');
process.exit(2);
`;

interface StubState {
  dnsName: string;
  backend: string;
  serve: Record<string, string>;
  calls: string[][];
  failServe?: string;
}

let dir: string;
let stateFile: string;
let env: NodeJS.ProcessEnv;

async function stub(patch: Partial<StubState> = {}): Promise<void> {
  const state: StubState = {
    dnsName: `${DNS}.`,
    backend: 'Running',
    serve: { '443': `http://127.0.0.1:${BOARD_PORT}`, '8080': 'http://127.0.0.1:8080' },
    calls: [],
    ...patch,
  };
  await writeFile(stateFile, JSON.stringify(state));
}

const readStub = async (): Promise<StubState> => JSON.parse(await readFile(stateFile, 'utf8'));
const serveCalls = async () =>
  (await readStub()).calls.filter((c) => c[0] === 'serve' && c[1] !== 'status');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yardmaster-ts-'));
  stateFile = join(dir, 'state.json');
  const bin = join(dir, 'bin');
  await import('node:fs/promises').then((fs) => fs.mkdir(bin));
  await writeFile(join(bin, 'tailscale'), STUB);
  await chmod(join(bin, 'tailscale'), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    TS_STUB_STATE: stateFile,
  };
  await stub();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function binding(port: number, address = '127.0.0.1'): PortBinding {
  return {
    id: `${address}:${port}`,
    port,
    address,
    pid: 4821,
    command: 'node',
    terminalId: null,
    projectId: null,
    firstSeenAt: T0,
  };
}

function shares(overrides: Partial<PortSharesOptions> = {}) {
  const store = new BoardStore();
  let saved: unknown = overrides.load?.() ?? [];
  const instance = new PortShares({
    store,
    cli: createTailscaleCli({ env, platform: 'linux' }),
    load: () => saved,
    save: (value) => {
      saved = value;
    },
    phoneAccess: () => true,
    boardPort: BOARD_PORT,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    probe: async () => null,
    closedGraceMs: 20,
    now: () => T0,
    ...overrides,
  });
  return { store, instance, saved: () => saved };
}

describe('PortShares', () => {
  it('shares a listening port on the tailnet and reports its URL', async () => {
    const { store, instance, saved } = shares();
    store.setPorts([binding(3000)]);
    store.flush();
    await instance.start();

    const result = await instance.share(3000);
    expect(result).toEqual({
      ok: true,
      share: { port: 3000, url: `https://${DNS}:3000`, mine: true, sharedAt: T0, hint: null },
    });
    expect(await serveCalls()).toEqual([
      ['serve', '--bg', '--https=3000', 'http://127.0.0.1:3000'],
    ]);
    expect((await readStub()).serve['3000']).toBe('http://127.0.0.1:3000');
    expect(saved()).toEqual([{ port: 3000, sharedAt: T0 }]);

    const status = await instance.status();
    expect(status.available).toBe(true);
    expect(status.host).toBe(DNS);
    // The board's own 443 entry is never listed; the user's 8080 is, as not ours.
    expect(status.shares.map((s) => [s.port, s.mine])).toEqual([
      [3000, true],
      [8080, false],
    ]);
    // Sharing again changes nothing.
    await instance.share(3000);
    expect(await serveCalls()).toHaveLength(1);
    await instance.stop();
  });

  it('forwards to IPv6 loopback when the port listens only there', async () => {
    const { store, instance } = shares();
    store.setPorts([binding(5173, '::1')]);
    await instance.share(5173);
    expect(await serveCalls()).toEqual([['serve', '--bg', '--https=5173', 'http://[::1]:5173']]);
  });

  it('removes its entry once the port stops listening', async () => {
    const { store, instance, saved } = shares();
    store.setPorts([binding(3000)]);
    store.flush();
    await instance.start();
    await instance.share(3000);

    store.setPorts([]);
    store.flush();
    await vi.waitFor(async () => expect((await readStub()).serve['3000']).toBeUndefined());
    expect(saved()).toEqual([]);
    expect(instance.ownPorts).toEqual([]);
    const { serve } = await readStub();
    expect(Object.keys(serve).sort()).toEqual(['443', '8080']);
    await instance.stop();
  });

  it('keeps a port that comes back within the grace period', async () => {
    const { store, instance } = shares({ closedGraceMs: 200 });
    store.setPorts([binding(3000)]);
    store.flush();
    await instance.start();
    await instance.share(3000);
    store.setPorts([]);
    store.flush();
    store.setPorts([binding(3000)]);
    store.flush();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(instance.ownPorts).toEqual([3000]);
    await instance.stop();
  });

  it('removes only its own entries on stop, never the board’s or the user’s', async () => {
    const { store, instance } = shares();
    store.setPorts([binding(3000), binding(5173), binding(8080)]);
    await instance.start();
    await instance.share(3000);
    await instance.share(5173);
    await instance.stop();

    const state = await readStub();
    expect(Object.keys(state.serve).sort()).toEqual(['443', '8080']);
    const offs = state.calls.filter((c) => c.includes('off'));
    expect(offs).toEqual([
      ['serve', '--https=3000', 'off'],
      ['serve', '--https=5173', 'off'],
    ]);
  });

  it('never takes over or removes an entry the user made', async () => {
    const { store, instance } = shares();
    store.setPorts([binding(8080), binding(BOARD_PORT)]);
    const result = await instance.share(8080);
    expect(result).toMatchObject({ ok: true, share: { port: 8080, mine: false } });
    expect(await instance.unshare(8080)).toEqual({ ok: false, error: 'foreign' });
    expect(await instance.share(BOARD_PORT)).toMatchObject({ ok: false, error: 'board_port' });
    expect(await instance.unshare(BOARD_PORT)).toEqual({ ok: false, error: 'not_shared' });
    await instance.stop();
    expect(await serveCalls()).toEqual([]);
    expect(Object.keys((await readStub()).serve).sort()).toEqual(['443', '8080']);
  });

  it('stops sharing on request', async () => {
    const { store, instance, saved } = shares();
    store.setPorts([binding(3000)]);
    await instance.share(3000);
    expect(await instance.unshare(3000)).toEqual({ ok: true });
    expect((await readStub()).serve['3000']).toBeUndefined();
    expect(saved()).toEqual([]);
    expect(await instance.unshare(3000)).toEqual({ ok: false, error: 'not_shared' });
  });

  it('removes entries left by a run that did not stop, and only those', async () => {
    await stub({
      serve: {
        '443': `http://127.0.0.1:${BOARD_PORT}`,
        '3000': 'http://127.0.0.1:3000',
        '8080': 'http://127.0.0.1:8080',
      },
    });
    const { instance, saved } = shares({
      load: () => [{ port: 3000, sharedAt: T0 - 1 }, { port: BOARD_PORT, sharedAt: T0 }, 'junk'],
    });
    await instance.start();
    expect(Object.keys((await readStub()).serve).sort()).toEqual(['443', '8080']);
    expect(await serveCalls()).toEqual([['serve', '--https=3000', 'off']]);
    expect(saved()).toEqual([]);
    await instance.stop();
  });

  it('refuses a port nothing listens on', async () => {
    const { instance } = shares();
    expect(await instance.share(3000)).toMatchObject({ ok: false, error: 'not_listening' });
    expect(await serveCalls()).toEqual([]);
  });

  it('reports Tailscale’s own message when serve fails', async () => {
    await stub({ failServe: 'Serve is not enabled on your tailnet.' });
    const { store, instance, saved } = shares();
    store.setPorts([binding(3000)]);
    const result = await instance.share(3000);
    expect(result).toEqual({
      ok: false,
      error: 'serve_failed',
      message: 'Serve is not enabled on your tailnet.',
    });
    expect(saved()).toEqual([]);
  });

  it('is unavailable without the binary, phone access or a running Tailscale', async () => {
    const empty = join(dir, 'empty');
    await import('node:fs/promises').then((fs) => fs.mkdir(empty));
    const missing = shares({
      cli: createTailscaleCli({ env: { PATH: empty }, platform: 'linux' }),
    });
    missing.store.setPorts([binding(3000)]);
    expect(await missing.instance.status()).toEqual({
      available: false,
      reason: 'not_installed',
      host: null,
      shares: [],
    });
    expect(await missing.instance.share(3000)).toMatchObject({ ok: false, error: 'unavailable' });
    await missing.instance.stop();

    const noPhone = shares({ phoneAccess: () => false });
    expect((await noPhone.instance.status()).reason).toBe('no_phone_access');

    await stub({ backend: 'NeedsLogin', dnsName: '' });
    const loggedOut = shares();
    expect((await loggedOut.instance.status()).reason).toBe('not_connected');
    expect((await readStub()).calls.filter((c) => c[0] === 'serve')).toEqual([]);
  });

  it('passes the Vite hint along', async () => {
    const { store, instance } = shares({ probe: async () => 'vite_blocked' });
    store.setPorts([binding(5173)]);
    expect(await instance.share(5173)).toMatchObject({ ok: true, share: { hint: 'vite_blocked' } });
    expect((await instance.status()).shares[0]?.hint).toBe('vite_blocked');
    await instance.stop();
  });
});

describe('servedPorts', () => {
  it('reads ports from TCP and Web, and rejects garbage', () => {
    expect(servedPorts('{"TCP":{"443":{"HTTPS":true}},"Web":{"a.ts.net:3000":{}}}')).toEqual(
      new Set([443, 3000]),
    );
    expect(servedPorts('')).toEqual(new Set());
    expect(servedPorts('{}')).toEqual(new Set());
    expect(servedPorts('not json')).toBeNull();
  });
});

describe('probeViteBlock', () => {
  let http: Server | undefined;
  afterEach(() => http?.close());

  async function listen(status: number, body: string): Promise<{ port: number; hosts: string[] }> {
    const hosts: string[] = [];
    http = createServer((req, res) => {
      hosts.push(req.headers.host ?? '');
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(body);
    });
    await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));
    return { port: (http.address() as AddressInfo).port, hosts };
  }

  it('spots Vite’s Blocked request answer for the tailnet name', async () => {
    const { port, hosts } = await listen(
      403,
      `Blocked request. This host ("${DNS}") is not allowed.\nTo allow this host, add "${DNS}" to \`server.allowedHosts\` in vite.config.js.`,
    );
    expect(await probeViteBlock({ address: '127.0.0.1', port }, DNS)).toBe('vite_blocked');
    expect(hosts).toEqual([`${DNS}:${port}`]);
  });

  it('is quiet for a normal answer or nothing listening', async () => {
    const { port } = await listen(200, '<!doctype html>');
    expect(await probeViteBlock({ address: '127.0.0.1', port }, DNS)).toBeNull();
    http?.close();
    expect(await probeViteBlock({ address: '127.0.0.1', port }, DNS, 500)).toBeNull();
  });
});

describe('port share routes', () => {
  const config: ServerConfig = {
    port: BOARD_PORT,
    host: '127.0.0.1',
    home: '/home/dev/.yardmaster',
    logLevel: 'silent',
    devOrigins: [],
  };
  const token = generateToken();
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, auth = true) =>
    (app as FastifyInstance).inject({
      method,
      url,
      headers: { host: `127.0.0.1:${BOARD_PORT}`, ...(auth ? { [TOKEN_HEADER]: token } : {}) },
    });

  it('shares, lists and stops sharing behind the auth guard, and cleans up on close', async () => {
    app = await buildServer(config, {
      token,
      dbPath: ':memory:',
      processes: false,
      git: false,
      tailscale: createTailscaleCli({ env, platform: 'linux' }),
      portShareProbe: async () => null,
    });
    expect((await call('GET', '/api/ports/shares', false)).statusCode).toBe(401);
    // Phone access isn't set up yet.
    expect((await call('GET', '/api/ports/shares')).json()).toMatchObject({
      available: false,
      reason: 'no_phone_access',
    });
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { host: `127.0.0.1:${BOARD_PORT}`, [TOKEN_HEADER]: token },
      payload: { remoteAllowedHosts: [DNS] },
    });
    app.store.setPorts([binding(3000)]);
    app.store.flush();

    expect((await call('POST', '/api/ports/abc/share')).statusCode).toBe(400);
    expect((await call('POST', '/api/ports/3001/share')).statusCode).toBe(409);
    const shared = await call('POST', '/api/ports/3000/share');
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toMatchObject({ url: `https://${DNS}:3000`, mine: true });
    const listed = (await call('GET', '/api/ports/shares')).json();
    expect(listed).toMatchObject({ available: true, reason: null, host: DNS });
    expect(listed.shares.map((s: { port: number }) => s.port)).toEqual([3000, 8080]);
    expect((await call('DELETE', '/api/ports/8080/share')).statusCode).toBe(409);
    expect((await call('DELETE', '/api/ports/3000/share')).statusCode).toBe(200);
    expect((await call('DELETE', '/api/ports/3000/share')).statusCode).toBe(404);

    await call('POST', '/api/ports/3000/share');
    expect((await readStub()).serve['3000']).toBeDefined();
    await app.close();
    app = undefined;
    expect(Object.keys((await readStub()).serve).sort()).toEqual(['443', '8080']);
  });
});
