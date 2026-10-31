import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OBSERVER_EVENTS } from '@yardmaster/hook';
import {
  BoardSettings,
  HooksInstallResponse,
  HooksPlanResponse,
  HooksStatusResponse,
  LibraryResponse,
  ServerStatus,
} from '@yardmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './app.js';
import { hookFixture } from './claude/fixtures.test-helpers.js';
import { HOOK_ROUTE } from './claude/hook-ingest.js';
import type { ServerConfig } from './config.js';
import { localInject } from './local-channel.test-helpers.js';
import { sessionHeader } from './sessions.test-helpers.js';
import {
  diskHookSettings,
  editorCliSetting,
  type HookSettingsFile,
  librarySettings,
  memoryHookSettings,
  migrateTerminalReply,
  terminalReplyEnabled,
} from './settings-routes.js';
import { generateToken } from './token.js';

const host = '127.0.0.1:4317';
const LIBRARY_DEFAULTS = {
  usageWarnFiveHour: 80,
  usageWarnSevenDay: 80,
  libraryRoots: [],
  libraryIdleHideMin: 30,
  pinnedProjects: [],
  editorCli: null,
  remoteAllowedHosts: [],
  notifyEvents: ['needs_you', 'claude_finished', 'command_finished', 'crashed'],
  notifyHideDetails: false,
  notifyMutedProjects: [],
};
const HOOK = '/opt/yardmaster/bin/yardmaster-hook';

let app: FastifyInstance | undefined;
let home: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function boot(
  options: { token?: string; hookSettings?: HookSettingsFile; demo?: boolean } = {},
) {
  home = await mkdtemp(join(tmpdir(), 'yardmaster-settings-'));
  const config: ServerConfig = {
    port: 4317,
    host: '127.0.0.1',
    home,
    logLevel: 'silent',
    devOrigins: [],
  };
  const token = options.token ?? generateToken();
  app = await buildServer(config, {
    token,
    dbPath: options.demo ? undefined : join(home, 'board.db'),
    processes: false,
    git: false,
    hookSettings: options.hookSettings ?? memoryHookSettings(),
    ...(options.demo ? { demo: true } : {}),
  });
  return { app, token, home, config };
}

function call(
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  token: string | null,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return (app as FastifyInstance).inject({
    method,
    url,
    headers: {
      host,
      ...(token ? { 'x-yardmaster-token': token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

describe('claude.terminalReply', () => {
  it('is on by default and reads the old experimental key', () => {
    expect(terminalReplyEnabled({})).toBe(true);
    expect(terminalReplyEnabled({ 'experimental.terminalReply': false })).toBe(false);
    expect(terminalReplyEnabled({ 'experimental.terminalReply': true })).toBe(true);
    expect(
      terminalReplyEnabled({ 'experimental.terminalReply': false, 'claude.terminalReply': true }),
    ).toBe(true);
    expect(terminalReplyEnabled({ 'claude.terminalReply': 'yes' })).toBe(true);
  });

  it('migrates a stored false to the new key once, keeping the old key', () => {
    const saved: [string, unknown][] = [];
    const save = (key: string, value: unknown) => saved.push([key, value]);
    const settings: Record<string, unknown> = { 'experimental.terminalReply': false };
    migrateTerminalReply(settings, save);
    migrateTerminalReply(settings, save);
    expect(saved).toEqual([['claude.terminalReply', false]]);
    expect(settings).toEqual({
      'experimental.terminalReply': false,
      'claude.terminalReply': false,
    });

    for (const other of [{}, { 'experimental.terminalReply': true }]) {
      migrateTerminalReply({ ...other }, save);
    }
    migrateTerminalReply(
      { 'experimental.terminalReply': false, 'claude.terminalReply': true },
      save,
    );
    expect(saved).toHaveLength(1);
  });
});

describe('settings routes', () => {
  it('every route needs auth', async () => {
    await boot();
    for (const [method, url] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['GET', '/api/hooks'],
      ['POST', '/api/hooks/plan'],
      ['POST', '/api/hooks/install'],
      ['POST', '/api/token/rotate'],
      ['GET', '/api/library'],
    ] as const) {
      expect((await call(method, url, null, {})).statusCode, url).toBe(401);
    }
  });

  it('reads and writes the server settings, which survive a restart', async () => {
    const { token, config } = await boot();
    expect(BoardSettings.parse((await call('GET', '/api/settings', token)).json())).toEqual({
      retentionDays: 7,
      awayMode: false,
      awayTimeoutSec: 120,
      terminalReply: true,
      ...LIBRARY_DEFAULTS,
    });
    expect((await call('PUT', '/api/settings', token, { retentionDays: 5 })).statusCode).toBe(400);
    expect((await call('PUT', '/api/settings', token, { nope: true })).statusCode).toBe(400);

    const res = await call('PUT', '/api/settings', token, { retentionDays: 30 });
    expect(res.json()).toEqual({
      retentionDays: 30,
      awayMode: false,
      awayTimeoutSec: 120,
      terminalReply: true,
      ...LIBRARY_DEFAULTS,
    });
    await call('PUT', '/api/settings', token, {
      awayMode: true,
      awayTimeoutSec: 45,
      terminalReply: false,
    });
    expect(app?.settings['claude.terminalReply']).toBe(false);
    expect(app?.persistence.retention).toBe(30 * 24 * 60 * 60 * 1000);

    await app?.close();
    app = await buildServer(config, {
      token,
      dbPath: join(config.home, 'board.db'),
      processes: false,
      git: false,
      hookSettings: memoryHookSettings(),
    });
    expect((await call('GET', '/api/settings', token)).json()).toEqual({
      retentionDays: 30,
      awayMode: true,
      awayTimeoutSec: 45,
      terminalReply: false,
      ...LIBRARY_DEFAULTS,
    });
    expect(app.persistence.retention).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('stores the usage warnings, from the offered choices only', async () => {
    const { token } = await boot();
    expect((await call('PUT', '/api/settings', token, { usageWarnFiveHour: 73 })).statusCode).toBe(
      400,
    );
    const res = await call('PUT', '/api/settings', token, { usageWarnSevenDay: 95 });
    expect(res.json()).toMatchObject({ usageWarnFiveHour: 80, usageWarnSevenDay: 95 });
  });

  it('stores the library roots, idle window and pins, validated and deduplicated', async () => {
    const { token, config } = await boot();
    for (const bad of [
      { libraryRoots: ['Desktop'] },
      { libraryRoots: [''] },
      { libraryRoots: Array.from({ length: 9 }, (_, i) => `/srv/code/${i}`) },
      { libraryIdleHideMin: 7 },
      { pinnedProjects: [''] },
    ]) {
      expect((await call('PUT', '/api/settings', token, bad)).statusCode, JSON.stringify(bad)).toBe(
        400,
      );
    }
    const res = await call('PUT', '/api/settings', token, {
      libraryRoots: ['~/Desktop', ' /srv/code ', '~/Desktop'],
      libraryIdleHideMin: 60,
      pinnedProjects: ['p-1', 'p-1', 'p-2'],
    });
    expect(res.json()).toMatchObject({
      libraryRoots: ['~/Desktop', '/srv/code'],
      libraryIdleHideMin: 60,
      pinnedProjects: ['p-1', 'p-2'],
    });
    expect(app?.settings['library.roots']).toEqual(['~/Desktop', '/srv/code']);

    await app?.close();
    app = await buildServer(config, {
      token,
      dbPath: join(config.home, 'board.db'),
      processes: false,
      git: false,
      hookSettings: memoryHookSettings(),
    });
    expect((await call('GET', '/api/settings', token)).json()).toMatchObject({
      libraryRoots: ['~/Desktop', '/srv/code'],
      libraryIdleHideMin: 60,
      pinnedProjects: ['p-1', 'p-2'],
    });
  });

  it('stores the editor CLI path, absolute only, and clears it with null', async () => {
    const { token, config } = await boot();
    for (const bad of ['cursor', '', '~/bin/cursor']) {
      const res = await call('PUT', '/api/settings', token, { editorCli: bad });
      expect(res.statusCode, bad).toBe(400);
    }
    const res = await call('PUT', '/api/settings', token, { editorCli: ' /opt/tools/cursor ' });
    expect(res.json()).toMatchObject({ editorCli: '/opt/tools/cursor' });

    await app?.close();
    app = await buildServer(config, {
      token,
      dbPath: join(config.home, 'board.db'),
      processes: false,
      git: false,
      hookSettings: memoryHookSettings(),
    });
    expect((await call('GET', '/api/settings', token)).json()).toMatchObject({
      editorCli: '/opt/tools/cursor',
    });
    const cleared = await call('PUT', '/api/settings', token, { editorCli: null });
    expect(cleared.json()).toMatchObject({ editorCli: null });
    expect(editorCliSetting({ 'editor.cli': 'relative' })).toBeNull();
  });

  it('ignores stored library settings that no longer validate', () => {
    expect(
      librarySettings({
        'library.roots': ['relative', '/srv/code', 4],
        'library.idleHideMin': 9,
        'library.pinned': 'p-1',
      }),
    ).toEqual({ libraryRoots: ['/srv/code'], libraryIdleHideMin: 30, pinnedProjects: [] });
  });

  it('lists the library from the configured roots', async () => {
    const { token, home } = await boot();
    const root = join(home, 'Desktop');
    await mkdir(join(root, 'acme-shop', '.git'), { recursive: true });
    await writeFile(join(root, 'notes.md'), 'synthetic');

    const empty = LibraryResponse.parse((await call('GET', '/api/library', token)).json());
    expect(empty).toEqual({ roots: [], entries: [] });

    await call('PUT', '/api/settings', token, { libraryRoots: [root, join(home, 'missing')] });
    const listed = LibraryResponse.parse((await call('GET', '/api/library', token)).json());
    expect(listed.roots.map((r) => [r.count, r.error])).toEqual([
      [1, null],
      [0, 'missing'],
    ]);
    expect(listed.entries.map((e) => [e.name, e.git])).toEqual([['acme-shop', true]]);
  });

  it('gives the demo board a synthetic library, under ~/Desktop until changed', async () => {
    const { token } = await boot({ demo: true });
    const settings = BoardSettings.parse((await call('GET', '/api/settings', token)).json());
    expect(settings.libraryRoots).toEqual(['~/Desktop']);
    const listed = LibraryResponse.parse((await call('GET', '/api/library', token)).json());
    expect(listed.entries.length).toBeGreaterThan(4);
    expect(listed.entries.every((e) => e.path.startsWith('/home/dev/'))).toBe(true);
    expect(listed.entries.find((e) => e.name === 'garden-planner')?.projectId).toBeNull();
    expect(listed.entries[0]?.projectId).not.toBeNull();
    await call('PUT', '/api/settings', token, { libraryRoots: [] });
    expect((await call('GET', '/api/library', token)).json()).toEqual({ roots: [], entries: [] });
  });

  it('plans, confirms and installs the hooks, writing only what was shown', async () => {
    const hooks = memoryHookSettings(`${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
    const { token } = await boot({ hookSettings: hooks });

    const before = HooksStatusResponse.parse((await call('GET', '/api/hooks', token)).json());
    expect(before).toEqual({
      path: '~/.claude/settings.json',
      status: { installed: [], missing: [...OBSERVER_EVENTS], outdated: [] },
      error: null,
    });

    const plan = HooksPlanResponse.parse((await call('POST', '/api/hooks/plan', token)).json());
    expect(plan.changed).toBe(true);
    expect(plan.diff).toContain('--- ~/.claude/settings.json');
    expect(plan.diff).toContain(`+${' '.repeat(12)}"command": "${HOOK}"`);
    expect(plan.diff).toContain(' "model": "opus"');

    // Bad body, then a stale plan: nothing is written.
    expect((await call('POST', '/api/hooks/install', token, {})).statusCode).toBe(400);
    const stale = await call('POST', '/api/hooks/install', token, { fingerprint: 'x' });
    expect(stale.statusCode).toBe(409);
    expect(await hooks.read()).not.toContain(HOOK);

    const done = HooksInstallResponse.parse(
      (await call('POST', '/api/hooks/install', token, { fingerprint: plan.fingerprint })).json(),
    );
    expect(done).toMatchObject({ ok: true, changed: true, backup: null });
    expect(done.status.installed).toEqual([...OBSERVER_EVENTS]);
    expect(JSON.parse((await hooks.read()) ?? '{}').model).toBe('opus');

    const again = HooksPlanResponse.parse((await call('POST', '/api/hooks/plan', token)).json());
    expect(again).toMatchObject({ changed: false, diff: '' });
  });

  it('installs into a real settings file with a backup, and reports a broken one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yardmaster-claude-'));
    try {
      const path = join(dir, 'settings.json');
      await writeFile(path, '{ "hooks": {} }\n');
      const file = diskHookSettings({ CLAUDE_CONFIG_DIR: dir }, '/home/dev');
      const { token } = await boot({ hookSettings: file });

      const plan = HooksPlanResponse.parse((await call('POST', '/api/hooks/plan', token)).json());
      const done = HooksInstallResponse.parse(
        (await call('POST', '/api/hooks/install', token, { fingerprint: plan.fingerprint })).json(),
      );
      expect(done.backup).toMatch(/settings\.json\.yardmaster-backup-/);
      expect((await readdir(dir)).some((name) => name.includes('yardmaster-backup'))).toBe(true);
      expect(JSON.parse(await readFile(path, 'utf8')).hooks.Stop).toHaveLength(1);

      await writeFile(path, '{ not json');
      const broken = HooksStatusResponse.parse((await call('GET', '/api/hooks', token)).json());
      expect(broken.status).toBeNull();
      expect(broken.error).toMatch(/not valid JSON/);
      const refused = await call('POST', '/api/hooks/plan', token);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: 'invalid_settings' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rotates the token: the old one and every session stop working, this browser stays in', async () => {
    const { token, home, app } = await boot();
    const mine = sessionHeader(app, 'Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36');
    const other = sessionHeader(app);
    const res = await call('POST', '/api/token/rotate', null, {}, mine);
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const body = res.json() as { ok: true; session: string };
    expect(body.session).toMatch(/^[\w-]+\.[\w-]+$/);

    const next = (await readFile(join(home, 'token'), 'utf8')).trim();
    expect(next).not.toBe(token);
    expect((await call('GET', '/api/settings', token)).statusCode).toBe(401);
    expect((await call('GET', '/api/settings', next)).statusCode).toBe(200);
    expect((await call('GET', '/api/settings', null, undefined, mine)).statusCode).toBe(401);
    expect((await call('GET', '/api/settings', null, undefined, other)).statusCode).toBe(401);
    const fresh = { 'x-yardmaster-session': body.session };
    expect((await call('GET', '/api/settings', null, undefined, fresh)).statusCode).toBe(200);
    expect(app.browserSessions.list()).toHaveLength(1);
  });

  it('ends every session when the token changed on disk while the board was down', async () => {
    const { app: first, config } = await boot();
    sessionHeader(first);
    expect(first.browserSessions.list()).toHaveLength(1);
    await first.close();
    app = await buildServer(config, {
      token: generateToken(),
      dbPath: join(config.home, 'board.db'),
      processes: false,
      git: false,
      hookSettings: memoryHookSettings(),
    });
    expect(app.browserSessions.list()).toEqual([]);
  });

  it('keeps sessions across a restart with the same token', async () => {
    const { app: first, config, token } = await boot();
    const header = sessionHeader(first);
    await first.close();
    app = await buildServer(config, {
      token,
      dbPath: join(config.home, 'board.db'),
      processes: false,
      git: false,
      hookSettings: memoryHookSettings(),
    });
    expect((await call('GET', '/api/settings', null, undefined, header)).statusCode).toBe(200);
  });

  it('never rotates in demo mode', async () => {
    const { token } = await boot({ demo: true });
    const res = await call('POST', '/api/token/rotate', token);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'demo' });
  });

  it('remembers the first hook event across restarts', async () => {
    const { token, config } = await boot();
    const status = async () =>
      ServerStatus.parse((await call('GET', '/api/status', token)).json()).setup;
    expect(await status()).toEqual({ hookSeen: false, editorSeen: false });

    const posted = await localInject(app as FastifyInstance, {
      method: 'POST',
      url: HOOK_ROUTE,
      headers: { 'x-yardmaster-token': token, 'content-type': 'application/json' },
      payload: JSON.stringify(hookFixture('session-start')),
    });
    expect(posted.statusCode).toBe(204);
    // The route records events after replying.
    await new Promise((resolve) => setImmediate(resolve));
    await app?.hookIngest.idle();
    expect(await status()).toEqual({ hookSeen: true, editorSeen: false });

    await app?.close();
    app = await buildServer(config, {
      token,
      dbPath: join(config.home, 'board.db'),
      processes: false,
      git: false,
      hookSettings: memoryHookSettings(),
    });
    expect(await status()).toEqual({ hookSeen: true, editorSeen: false });
  });
});
