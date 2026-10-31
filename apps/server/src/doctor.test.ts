import { statuslineCommand } from '@yardmaster/hook';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from './config.js';
import {
  claudeSettingsPath,
  type DoctorCheck,
  type DoctorDeps,
  formatDoctorReport,
  installedHookEvents,
  type JsonResponse,
  runDoctor,
  tildify,
} from './doctor.js';
import { generateToken } from './token.js';

const HOME = '/home/dev';
const config: ServerConfig = {
  port: 4317,
  host: '127.0.0.1',
  home: '/home/dev/.yardmaster',
  logLevel: 'silent',
  devOrigins: [],
};
const TOKEN = generateToken();
const NOW = 1_800_000_000_000;

const hookSettings = JSON.stringify({
  model: 'opus',
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: '/opt/yardmaster/bin/yardmaster-hook' }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: 'say done' }] },
      { hooks: [{ type: 'command', command: '/opt/yardmaster/bin/yardmaster-hook', async: true }] },
    ],
    Notification: [{ hooks: [{ type: 'command', command: 'notify-send hi' }] }],
  },
});

interface FakeWorld {
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  portFree?: boolean;
  files?: Record<string, { text: string; mode?: number }>;
  /** TCP URLs, and `local:<path>` for requests over the board's socket. */
  http?: Record<string, JsonResponse>;
  /** The socket at `~/.yardmaster/board.sock`; there by default when `http` has local routes. */
  socket?: { isSocket: boolean; ours: boolean } | null;
  executables?: string[];
  commands?: Record<string, string | undefined>;
  pty?: { ok: true } | { ok: false; reason: string };
}

function fakeDeps(world: FakeWorld = {}): DoctorDeps & { requests: [string, unknown][] } {
  const files = world.files ?? {
    '/home/dev/.yardmaster/token': { text: `${TOKEN}\n`, mode: 0o100600 },
  };
  const requests: [string, unknown][] = [];
  return {
    requests,
    env: world.env ?? { PATH: '/usr/local/bin:/usr/bin' },
    home: HOME,
    nodeVersion: world.nodeVersion ?? 'v22.12.0',
    platform: 'linux',
    isPortFree: async () => world.portFree ?? true,
    getJson: async (url, headers) => {
      requests.push([url, headers]);
      return world.http?.[url];
    },
    getLocalJson: async (socketPath, path, headers) => {
      expect(socketPath).toBe('/home/dev/.yardmaster/board.sock');
      requests.push([`local:${path}`, headers]);
      return world.http?.[`local:${path}`];
    },
    socketInfo: async (path) => {
      if (path !== '/home/dev/.yardmaster/board.sock') return undefined;
      if (world.socket !== undefined) return world.socket ?? undefined;
      const local = Object.keys(world.http ?? {}).some((url) => url.startsWith('local:'));
      return local ? { isSocket: true, ours: true } : undefined;
    },
    readText: async (path) => files[path]?.text,
    fileInfo: async (path) => {
      const file = files[path];
      return file
        ? { mode: file.mode ?? 0o100600, isFile: !(file.mode && file.mode & 0o40000) }
        : undefined;
    },
    isExecutable: async (path) => (world.executables ?? ['/usr/local/bin/claude']).includes(path),
    run: async (file, args) =>
      world.commands ? world.commands[`${file} ${args.join(' ')}`] : '2.1.0 (Claude Code)\n',
    loadPty: async () => world.pty ?? { ok: true },
  };
}

const byId = (checks: DoctorCheck[], id: DoctorCheck['id']) => {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check;
};

const health = { status: 200, body: { ok: true, version: '1.2.3' } };
const runningBoard = (status: object = {}): FakeWorld['http'] => ({
  'http://127.0.0.1:4317/api/health': health,
  'local:/api/health': health,
  'local:/api/status': {
    status: 200,
    body: {
      ok: true,
      version: '1.2.3',
      demo: false,
      uptimeMs: 1000,
      editors: 2,
      hooks: { received: 14, lastAt: NOW - 90_000 },
      setup: { hookSeen: true, editorSeen: true },
      ...status,
    },
  },
});

describe('runDoctor', () => {
  it('reports every check in a fixed order', async () => {
    const checks = await runDoctor(config, fakeDeps(), NOW);
    expect(checks.map((c) => c.id)).toEqual([
      'node',
      'server',
      'token',
      'data',
      'channel',
      'hooks',
      'statusline',
      'extensions',
      'editor-cli',
      'pty',
      'claude',
      'api-key',
    ]);
  });

  describe('node', () => {
    it.each([
      ['v22.5.0', 'ok'],
      ['v25.2.0', 'ok'],
      ['v22.4.1', 'fail'],
      ['v20.18.0', 'fail'],
    ])('%s is %s', async (nodeVersion, level) => {
      const checks = await runDoctor(config, fakeDeps({ nodeVersion }), NOW);
      expect(byId(checks, 'node').level).toBe(level);
    });
  });

  describe('server and port', () => {
    it('is ok when the port is free and nothing runs', async () => {
      const deps = fakeDeps({ portFree: true });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'server')).toMatchObject({ level: 'ok' });
      expect(byId(checks, 'server').message).toContain('port 4317 is free');
      expect(byId(checks, 'extensions').level).toBe('skip');
      expect(deps.requests).toEqual([]);
    });

    it('recognises a running board by its health route', async () => {
      const checks = await runDoctor(
        config,
        fakeDeps({ portFree: false, http: runningBoard() }),
        NOW,
      );
      expect(byId(checks, 'server')).toMatchObject({
        level: 'ok',
        message: 'Yardmaster 1.2.3 is running on 127.0.0.1:4317',
      });
    });

    it('mentions demo mode', async () => {
      const checks = await runDoctor(
        config,
        fakeDeps({ portFree: false, http: runningBoard({ demo: true }) }),
        NOW,
      );
      expect(byId(checks, 'server').message).toContain('(demo mode)');
    });

    it('warns when board sessions run on a server that restarts on edits', async () => {
      const watched = await runDoctor(
        config,
        fakeDeps({ portFree: false, http: runningBoard({ watched: true, boardSessions: 2 }) }),
        NOW,
      );
      expect(byId(watched, 'server')).toMatchObject({ level: 'warn' });
      expect(byId(watched, 'server').message).toContain('2 board sessions running');
      expect(byId(watched, 'server').hint).toContain('pnpm board');

      const idle = await runDoctor(
        config,
        fakeDeps({ portFree: false, http: runningBoard({ watched: true, boardSessions: 0 }) }),
        NOW,
      );
      expect(byId(idle, 'server').level).toBe('ok');
    });

    it('fails when another program holds the port', async () => {
      const checks = await runDoctor(
        config,
        fakeDeps({
          portFree: false,
          http: { 'http://127.0.0.1:4317/api/health': { status: 200, body: '<html>' } },
        }),
        NOW,
      );
      expect(byId(checks, 'server')).toMatchObject({ level: 'fail' });
      expect(byId(checks, 'server').hint).toContain('YARDMASTER_PORT');
    });

    it('fails when the port is taken and nothing answers HTTP', async () => {
      const checks = await runDoctor(config, fakeDeps({ portFree: false }), NOW);
      expect(byId(checks, 'server').level).toBe('fail');
    });
  });

  describe('data dir', () => {
    const TOKEN_FILE = { '/home/dev/.yardmaster/token': { text: `${TOKEN}\n`, mode: 0o100600 } };
    const world = (dir: number, db?: number): FakeWorld => ({
      files: {
        ...TOKEN_FILE,
        '/home/dev/.yardmaster': { text: '', mode: dir },
        ...(db === undefined ? {} : { '/home/dev/.yardmaster/board.db': { text: '', mode: db } }),
      },
    });

    it('is ok for a 0700 dir and a 0600 board.db', async () => {
      const checks = await runDoctor(config, fakeDeps(world(0o40700, 0o100600)), NOW);
      expect(byId(checks, 'data')).toMatchObject({
        level: 'ok',
        message: '~/.yardmaster (0700), board.db (0600)',
      });
    });

    it('says when board.db is not created yet', async () => {
      const checks = await runDoctor(config, fakeDeps(world(0o40700)), NOW);
      expect(byId(checks, 'data')).toMatchObject({ level: 'ok' });
      expect(byId(checks, 'data').message).toContain('no board.db yet');
    });

    it('warns about a dir or a database other users can read', async () => {
      const checks = await runDoctor(config, fakeDeps(world(0o40755, 0o100644)), NOW);
      const data = byId(checks, 'data');
      expect(data.level).toBe('warn');
      expect(data.message).toContain('~/.yardmaster (mode 0755)');
      expect(data.message).toContain('board.db (mode 0644)');
      expect(data.hint).toContain('chmod 700 ~/.yardmaster');
    });

    it('warns when the dir is missing', async () => {
      const checks = await runDoctor(config, fakeDeps(), NOW);
      expect(byId(checks, 'data')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'data').message).toContain('missing');
    });
  });

  describe('token', () => {
    it('is ok for a valid 0600 token, shown with ~', async () => {
      const checks = await runDoctor(config, fakeDeps(), NOW);
      expect(byId(checks, 'token')).toMatchObject({
        level: 'ok',
        message: '~/.yardmaster/token (0600)',
      });
    });

    it('warns when the token is missing', async () => {
      const checks = await runDoctor(config, fakeDeps({ files: {} }), NOW);
      expect(byId(checks, 'token')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'token').message).toContain('missing');
    });

    it('warns about an invalid token', async () => {
      const files = { '/home/dev/.yardmaster/token': { text: 'not-a-token' } };
      const checks = await runDoctor(config, fakeDeps({ files }), NOW);
      expect(byId(checks, 'token')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'token').hint).toContain('--rotate');
    });

    it('warns about loose permissions', async () => {
      const files = { '/home/dev/.yardmaster/token': { text: TOKEN, mode: 0o100644 } };
      const checks = await runDoctor(config, fakeDeps({ files }), NOW);
      expect(byId(checks, 'token')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'token').message).toContain('644');
    });
  });

  describe('hooks', () => {
    const tokenFile = { '/home/dev/.yardmaster/token': { text: TOKEN } };

    it('warns when Claude settings are missing', async () => {
      const checks = await runDoctor(config, fakeDeps({ files: tokenFile }), NOW);
      expect(byId(checks, 'hooks')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'hooks').hint).toContain('yardmaster hooks install');
    });

    it('warns when no Yardmaster hook is registered', async () => {
      const files = {
        ...tokenFile,
        '/home/dev/.claude/settings.json': { text: JSON.stringify({ hooks: {} }) },
      };
      const checks = await runDoctor(config, fakeDeps({ files }), NOW);
      expect(byId(checks, 'hooks')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'hooks').message).toContain('not installed');
    });

    it('reports the statusline forwarder, which is optional', async () => {
      const settings = (statusLine?: unknown) => ({
        ...tokenFile,
        '/home/dev/.claude/settings.json': { text: JSON.stringify({ statusLine }) },
      });
      const check = async (statusLine?: unknown) =>
        byId(await runDoctor(config, fakeDeps({ files: settings(statusLine) }), NOW), 'statusline');

      expect(await check()).toMatchObject({ level: 'skip' });
      expect(await check({ type: 'command', command: 'ccstatus' })).toMatchObject({
        level: 'skip',
      });
      expect(await check({ type: 'static' })).toMatchObject({ level: 'skip' });
      expect(
        await check({ type: 'command', command: statuslineCommand('ccstatus') }),
      ).toMatchObject({ level: 'ok', message: expect.stringContaining('runs your statusline') });
      expect(
        await check({ type: 'command', command: '/old/place/yardmaster-statusline ccstatus' }),
      ).toMatchObject({ level: 'warn' });
    });

    it('warns about invalid JSON', async () => {
      const files = { ...tokenFile, '/home/dev/.claude/settings.json': { text: '{ nope' } };
      const checks = await runDoctor(config, fakeDeps({ files }), NOW);
      expect(byId(checks, 'hooks').message).toContain('not valid JSON');
    });

    it('counts installed events', async () => {
      const files = { ...tokenFile, '/home/dev/.claude/settings.json': { text: hookSettings } };
      const checks = await runDoctor(config, fakeDeps({ files }), NOW);
      expect(byId(checks, 'hooks')).toMatchObject({
        level: 'ok',
        message: '2 events in ~/.claude/settings.json',
      });
    });

    it('honours CLAUDE_CONFIG_DIR', async () => {
      const files = { ...tokenFile, '/home/dev/alt-claude/settings.json': { text: hookSettings } };
      const env = { PATH: '/usr/local/bin', CLAUDE_CONFIG_DIR: '/home/dev/alt-claude' };
      const checks = await runDoctor(config, fakeDeps({ files, env }), NOW);
      expect(byId(checks, 'hooks').message).toBe('2 events in ~/alt-claude/settings.json');
    });

    it('adds received events from a running board', async () => {
      const files = { ...tokenFile, '/home/dev/.claude/settings.json': { text: hookSettings } };
      const checks = await runDoctor(
        config,
        fakeDeps({ files, portFree: false, http: runningBoard() }),
        NOW,
      );
      expect(byId(checks, 'hooks').message).toBe(
        '2 events in ~/.claude/settings.json; 14 received, last 2m ago',
      );
    });

    it('says when a running board has received nothing yet', async () => {
      const files = { ...tokenFile, '/home/dev/.claude/settings.json': { text: hookSettings } };
      const http = runningBoard({ hooks: { received: 0, lastAt: null } });
      const checks = await runDoctor(config, fakeDeps({ files, portFree: false, http }), NOW);
      expect(byId(checks, 'hooks').message).toContain('no events received yet');
    });
  });

  describe('local socket', () => {
    const tokenFile = { '/home/dev/.yardmaster/token': { text: TOKEN, mode: 0o100600 } };
    it('is ok when the board answers on its private socket', async () => {
      const files = {
        ...tokenFile,
        '/home/dev/.yardmaster': { text: '', mode: 0o40700 },
      };
      const checks = await runDoctor(
        config,
        fakeDeps({ files, portFree: false, http: runningBoard() }),
        NOW,
      );
      expect(byId(checks, 'channel')).toMatchObject({
        level: 'ok',
        message: '~/.yardmaster/board.sock (owner only)',
      });
    });

    it('is skipped when the board is not running', async () => {
      expect(byId(await runDoctor(config, fakeDeps(), NOW), 'channel').level).toBe('skip');
      const leftover = fakeDeps({ socket: { isSocket: true, ours: true } });
      expect(byId(await runDoctor(config, leftover, NOW), 'channel')).toMatchObject({
        level: 'skip',
        message: 'server not running (~/.yardmaster/board.sock is left over)',
      });
    });

    it('fails when the running board has no socket, or nothing answers on it', async () => {
      const http = { 'http://127.0.0.1:4317/api/health': health };
      const missing = await runDoctor(config, fakeDeps({ portFree: false, http }), NOW);
      expect(byId(missing, 'channel')).toMatchObject({
        level: 'fail',
        message: 'the running server does not listen on ~/.yardmaster/board.sock',
      });
      const silent = fakeDeps({ portFree: false, http, socket: { isSocket: true, ours: true } });
      expect(byId(await runDoctor(config, silent, NOW), 'channel')).toMatchObject({
        level: 'fail',
        message: 'nothing answers on ~/.yardmaster/board.sock',
      });
    });

    it('fails on a file that is not our socket', async () => {
      for (const socket of [
        { isSocket: false, ours: true },
        { isSocket: true, ours: false },
      ]) {
        const deps = fakeDeps({ portFree: false, http: runningBoard(), socket });
        expect(byId(await runDoctor(config, deps, NOW), 'channel')).toMatchObject({
          level: 'fail',
          message: '~/.yardmaster/board.sock is not a socket of yours',
        });
      }
    });

    it('warns when the data dir is open to other users', async () => {
      const files = { ...tokenFile, '/home/dev/.yardmaster': { text: '', mode: 0o40755 } };
      const deps = fakeDeps({ files, portFree: false, http: runningBoard() });
      expect(byId(await runDoctor(config, deps, NOW), 'channel')).toMatchObject({
        level: 'warn',
        message: '~/.yardmaster is open to other users (mode 755)',
      });
    });
  });

  describe('extensions', () => {
    it('reports connected windows, asking over the socket with the token', async () => {
      const deps = fakeDeps({ portFree: false, http: runningBoard() });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'extensions')).toMatchObject({
        level: 'ok',
        message: '2 windows connected',
      });
      expect(deps.requests).toContainEqual(['local:/api/status', { 'x-yardmaster-token': TOKEN }]);
      // Whatever holds the TCP port never sees the token.
      for (const [url, headers] of deps.requests) {
        if (url.startsWith('http:')) expect(headers).toBeUndefined();
      }
    });

    it('warns when no window is connected', async () => {
      const checks = await runDoctor(
        config,
        fakeDeps({ portFree: false, http: runningBoard({ editors: 0 }) }),
        NOW,
      );
      expect(byId(checks, 'extensions')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'extensions').hint).toContain('extension');
    });

    it('warns when the server rejects the token', async () => {
      const http = {
        ...runningBoard(),
        'local:/api/status': { status: 401, body: { error: 'unauthorized' } },
      };
      const checks = await runDoctor(config, fakeDeps({ portFree: false, http }), NOW);
      expect(byId(checks, 'extensions')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'extensions').message).toContain('rejected the token');
    });

    it('does not query the status without a token', async () => {
      const deps = fakeDeps({ portFree: false, http: runningBoard(), files: {} });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'extensions').level).toBe('warn');
      expect(deps.requests.map(([url]) => url)).not.toContain('local:/api/status');
    });

    it('ignores a malformed status body', async () => {
      const http = {
        ...runningBoard(),
        'local:/api/status': { status: 200, body: { editors: 'many' } },
      };
      const checks = await runDoctor(config, fakeDeps({ portFree: false, http }), NOW);
      expect(byId(checks, 'extensions').message).toContain('could not read');
    });
  });

  describe('claude binary', () => {
    it('reports the version of the first claude on PATH', async () => {
      const deps = fakeDeps({
        env: { PATH: '/home/dev/.local/bin:/usr/local/bin' },
        executables: ['/home/dev/.local/bin/claude', '/usr/local/bin/claude'],
        commands: { '/home/dev/.local/bin/claude --version': '2.3.4 (Claude Code)\n' },
      });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'claude')).toMatchObject({ level: 'ok', message: '2.3.4 (Claude Code)' });
    });

    it('warns when claude is not on PATH', async () => {
      const checks = await runDoctor(config, fakeDeps({ executables: [] }), NOW);
      expect(byId(checks, 'claude')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'claude').message).toContain('not on PATH');
    });

    it('warns when claude --version fails', async () => {
      const checks = await runDoctor(config, fakeDeps({ commands: {} }), NOW);
      expect(byId(checks, 'claude').message).toContain('failed');
    });
  });

  describe('editor CLI', () => {
    it('finds cursor on PATH', async () => {
      const deps = fakeDeps({ executables: ['/usr/local/bin/claude', '/usr/local/bin/cursor'] });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'editor-cli')).toMatchObject({
        level: 'ok',
        message: 'Cursor at /usr/local/bin/cursor',
      });
    });

    it('falls back to code', async () => {
      const deps = fakeDeps({ executables: ['/usr/bin/code'] });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'editor-cli').message).toBe('VS Code at /usr/bin/code');
    });

    it('warns when neither is found', async () => {
      const checks = await runDoctor(config, fakeDeps(), NOW);
      expect(byId(checks, 'editor-cli')).toMatchObject({ level: 'warn' });
      expect(byId(checks, 'editor-cli').hint).toContain('Settings → Projects');
    });

    it('reports what a running server found, including a path set in Settings', async () => {
      const http = runningBoard({
        editorCli: { path: '/home/dev/bin/cursor', app: 'Cursor', configured: true },
      });
      const checks = await runDoctor(config, fakeDeps({ portFree: false, http }), NOW);
      expect(byId(checks, 'editor-cli').message).toBe('Cursor at ~/bin/cursor (set in Settings)');
    });

    it('trusts a running server that found none', async () => {
      const http = runningBoard({ editorCli: null });
      const deps = fakeDeps({ portFree: false, http, executables: ['/usr/local/bin/cursor'] });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'editor-cli')).toMatchObject({ level: 'warn' });
    });
  });

  describe('board terminals', () => {
    it('is ok when node-pty loads', async () => {
      const checks = await runDoctor(config, fakeDeps(), NOW);
      expect(byId(checks, 'pty')).toMatchObject({ level: 'ok', message: 'node-pty loads' });
    });

    it('warns with the reason when it does not', async () => {
      const deps = fakeDeps({ pty: { ok: false, reason: 'node-pty did not load: no binary' } });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'pty')).toMatchObject({
        level: 'warn',
        message: 'node-pty did not load: no binary',
      });
      expect(byId(checks, 'pty').hint).toContain('editor window');
    });

    it('reports what a running server has', async () => {
      const http = runningBoard({
        boardTerminals: { available: true, reason: null, live: 3, max: 16 },
      });
      const deps = fakeDeps({ portFree: false, http, pty: { ok: false, reason: 'x' } });
      const checks = await runDoctor(config, deps, NOW);
      expect(byId(checks, 'pty').message).toBe('node-pty loads; 3 of 16 running');
    });
  });

  describe('ANTHROPIC_API_KEY', () => {
    it('is ok when unset', async () => {
      const checks = await runDoctor(config, fakeDeps(), NOW);
      expect(byId(checks, 'api-key').level).toBe('ok');
    });

    it('warns when set, without echoing the key', async () => {
      const key = ['sk', 'ant', 'test', 'value'].join('-');
      const env = { PATH: '/usr/local/bin', ANTHROPIC_API_KEY: key };
      const checks = await runDoctor(config, fakeDeps({ env }), NOW);
      expect(byId(checks, 'api-key')).toMatchObject({ level: 'warn' });
      expect(JSON.stringify(checks)).not.toContain(key);
    });
  });
});

describe('helpers', () => {
  it('finds Yardmaster hook events and ignores malformed entries', () => {
    expect(installedHookEvents(JSON.parse(hookSettings))).toEqual(['SessionStart', 'Stop']);
    expect(installedHookEvents(null)).toEqual([]);
    expect(installedHookEvents({ hooks: { Stop: 'x', Start: [null, { hooks: 3 }] } })).toEqual([]);
  });

  it('resolves the Claude settings path', () => {
    expect(claudeSettingsPath({}, HOME)).toBe('/home/dev/.claude/settings.json');
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/opt/claude' }, HOME)).toBe(
      '/opt/claude/settings.json',
    );
  });

  it('tildifies only paths under home', () => {
    expect(tildify('/home/dev/.yardmaster', HOME)).toBe('~/.yardmaster');
    expect(tildify('/home/devops/x', HOME)).toBe('/home/devops/x');
  });
});

describe('formatDoctorReport', () => {
  const checks: DoctorCheck[] = [
    { id: 'node', label: 'Node.js', level: 'ok', message: 'v22.12.0' },
    { id: 'hooks', label: 'Claude hooks', level: 'warn', message: 'not installed', hint: 'Fix.' },
    { id: 'server', label: 'Server', level: 'fail', message: 'port taken', hint: 'Stop it.' },
    { id: 'extensions', label: 'Editor extension', level: 'skip', message: 'server not running' },
  ];

  it('prints aligned rows, hints and a summary', () => {
    expect(formatDoctorReport(checks, { version: '1.0.0', color: false })).toBe(
      [
        'yardmaster doctor v1.0.0',
        '',
        '  ✓ Node.js           v22.12.0',
        '  ! Claude hooks      not installed',
        '                      Fix.',
        '  ✗ Server            port taken',
        '                      Stop it.',
        '  – Editor extension  server not running',
        '',
        '1 check passed, 1 warning, 1 failure',
        '',
      ].join('\n'),
    );
  });

  it('colours only when asked', () => {
    expect(formatDoctorReport(checks, { version: '1', color: true })).toContain('\x1b[31m✗');
    expect(formatDoctorReport(checks, { version: '1', color: false })).not.toContain('\x1b[');
  });
});
