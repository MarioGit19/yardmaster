import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import type { BuildOptions } from './app.js';
import { type CliIo, runCli, USAGE } from './cli-app.js';
import type { ServerConfig } from './config.js';
import { type DoctorDeps, defaultDoctorDeps } from './doctor.js';
import { browserCommand } from './open-browser.js';
import { ensureToken } from './token.js';

let home: string;
const closers: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yardmaster-cli-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(home, { recursive: true, force: true });
});

function testIo(env: NodeJS.ProcessEnv = {}, extra: Partial<CliIo> = {}) {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    env: { YARDMASTER_HOME: join(home, '.yardmaster'), YARDMASTER_LOG_LEVEL: 'silent', ...env },
    home,
    ...extra,
  };
  return { io, out: () => out, err: () => err };
}

describe('runCli', () => {
  it('prints help and the version', async () => {
    const help = testIo();
    expect(await runCli(['--help'], help.io)).toBe(0);
    expect(help.out()).toBe(USAGE);

    const version = testIo();
    expect(await runCli(['--version'], version.io)).toBe(0);
    expect(version.out()).toBe(`${pkg.version}\n`);
  });

  it('rejects unknown commands and flags', async () => {
    const unknown = testIo();
    expect(await runCli(['frobnicate'], unknown.io)).toBe(2);
    expect(unknown.err()).toContain('unknown command "frobnicate"');

    const badFlag = testIo();
    expect(await runCli(['doctor', '--wat'], badFlag.io)).toBe(2);
    expect(badFlag.err()).toContain('yardmaster doctor:');
  });

  it('reports config errors', async () => {
    const t = testIo({ YARDMASTER_HOST: '0.0.0.0' });
    expect(await runCli(['doctor'], t.io)).toBe(1);
    expect(t.err()).toContain('loopback');
  });
});

describe('yardmaster doctor', () => {
  const fakeDeps = (overrides: Partial<DoctorDeps>) => (config: ServerConfig) => ({
    ...defaultDoctorDeps(home, {}),
    isPortFree: async () => true,
    isExecutable: async () => false,
    ...overrides,
    home: config.home,
  });

  it('prints the report and exits 0 with only warnings', async () => {
    const t = testIo({}, { doctorDeps: fakeDeps({}) });
    expect(await runCli(['doctor'], t.io)).toBe(0);
    expect(t.out()).toContain('yardmaster doctor');
    expect(t.out()).toMatch(/Node\.js\s+v\d+/);
    expect(t.out()).not.toContain('\x1b[');
  });

  it('exits 1 when a check fails', async () => {
    const t = testIo({}, { doctorDeps: fakeDeps({ nodeVersion: 'v20.0.0' }) });
    expect(await runCli(['doctor'], t.io)).toBe(1);
    expect(t.out()).toContain('✗ Node.js');
  });

  it('uses colour on a TTY unless NO_COLOR is set', async () => {
    const tty = testIo({}, { doctorDeps: fakeDeps({}) });
    tty.io.stdout.isTTY = true;
    await runCli(['doctor'], tty.io);
    expect(tty.out()).toContain('\x1b[');

    const noColor = testIo({ NO_COLOR: '1' }, { doctorDeps: fakeDeps({}) });
    noColor.io.stdout.isTTY = true;
    await runCli(['doctor'], noColor.io);
    expect(noColor.out()).not.toContain('\x1b[');
  });
});

describe('yardmaster token', () => {
  it('needs --rotate', async () => {
    const t = testIo();
    expect(await runCli(['token'], t.io)).toBe(2);
    expect(t.err()).toContain('~/.yardmaster/token');
  });

  it('--rotate replaces the token with a new 0600 one', async () => {
    const dir = join(home, '.yardmaster');
    const before = await ensureToken(dir);
    const t = testIo();
    expect(await runCli(['token', '--rotate'], t.io)).toBe(0);
    const after = (await readFile(join(dir, 'token'), 'utf8')).trim();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(join(dir, 'token'))).mode & 0o777).toBe(0o600);
    expect(t.out()).not.toContain(after);
    expect(t.out()).toContain('Restart Yardmaster');
  });
});

describe('the rename from c-board', () => {
  it('prints a notice when run as c-board', async () => {
    const t = testIo({}, { invokedAs: 'c-board' });
    expect(await runCli(['--version'], t.io)).toBe(0);
    expect(t.err()).toContain('`c-board` is now `yardmaster`');
    const plain = testIo({}, { invokedAs: 'yardmaster' });
    await runCli(['--version'], plain.io);
    expect(plain.err()).toBe('');
  });

  it('moves ~/.c-board to ~/.yardmaster on start, keeping the token', async () => {
    const legacy = join(home, '.c-board');
    await mkdir(legacy);
    const token = await ensureToken(legacy);
    const calls: BuildOptions[] = [];
    const t = testIo(
      { YARDMASTER_HOME: '' },
      {
        startServer: async (_config, options) => {
          calls.push(options);
          return {
            server: { address: () => ({ port: 4317, address: '127.0.0.1', family: 'IPv4' }) },
            log: { info: () => {} },
          } as unknown as FastifyInstance;
        },
        openBrowser: async () => false,
      },
    );
    expect(await runCli(['start', '--no-open'], t.io)).toBeNull();
    expect(calls[0]?.token).toBe(token);
    expect(t.out()).toContain('Moved your data from ~/.c-board to ~/.yardmaster');
    expect((await lstat(legacy)).isSymbolicLink()).toBe(true);
    expect((await readFile(join(home, '.yardmaster', 'token'), 'utf8')).trim()).toBe(token);
  });

  it('leaves a data dir chosen through CBOARD_HOME where it is', async () => {
    const chosen = join(home, 'board');
    await mkdir(chosen);
    const token = await ensureToken(chosen);
    const t = testIo({ YARDMASTER_HOME: '', CBOARD_HOME: chosen });
    expect(await runCli(['token'], t.io)).toBe(2);
    expect(t.err()).toContain('~/board/token');
    expect((await readFile(join(chosen, 'token'), 'utf8')).trim()).toBe(token);
  });
});

describe('yardmaster start', () => {
  function fakeServer(port: number) {
    const calls: [ServerConfig, BuildOptions][] = [];
    const startServer = async (config: ServerConfig, options: BuildOptions) => {
      calls.push([config, options]);
      return {
        server: { address: () => ({ port, address: '127.0.0.1', family: 'IPv4' }) },
        log: { info: () => {} },
      } as unknown as FastifyInstance;
    };
    return { calls, startServer };
  }

  it('starts the server and opens the auth link', async () => {
    const { calls, startServer } = fakeServer(4317);
    const openBrowser = vi.fn(async () => true);
    const onStarted = vi.fn();
    const t = testIo({}, { startServer, openBrowser, onStarted });

    expect(await runCli(['start'], t.io)).toBeNull();
    const token = (await readFile(join(home, '.yardmaster', 'token'), 'utf8')).trim();
    expect(calls[0]?.[1]).toMatchObject({ token, demo: false });
    expect(calls[0]?.[1].webRoot).toMatch(/web[/\\]dist$/);
    expect(openBrowser).toHaveBeenCalledWith(`http://127.0.0.1:4317/auth?t=${token}`);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(t.out()).toContain('running at http://127.0.0.1:4317 (opened in your browser)');
    expect(t.out()).not.toContain(token);
  });

  it('--demo --no-open prints the link instead', async () => {
    const { calls, startServer } = fakeServer(4318);
    const openBrowser = vi.fn(async () => true);
    const t = testIo({ YARDMASTER_PORT: '0' }, { startServer, openBrowser });

    expect(await runCli(['start', '--demo', '--no-open'], t.io)).toBeNull();
    expect(calls[0]?.[1].demo).toBe(true);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(t.out()).toMatch(/Sign in with: http:\/\/127\.0\.0\.1:4318\/auth\?t=[\w-]{43}\n/);
  });

  it('treats bare flags as start', async () => {
    const { calls, startServer } = fakeServer(4317);
    const t = testIo({}, { startServer, openBrowser: async () => true });
    expect(await runCli(['--demo'], t.io)).toBeNull();
    expect(calls[0]?.[1].demo).toBe(true);
  });

  it('--demo-stress starts the stress demo board', async () => {
    const { calls, startServer } = fakeServer(4317);
    const t = testIo({}, { startServer, openBrowser: async () => true });
    expect(await runCli(['start', '--demo-stress', '--no-open'], t.io)).toBeNull();
    expect(calls[0]?.[1].demo).toEqual({ stress: true });
  });

  it('--demo-projects sizes the stress board, and only the stress board', async () => {
    const { calls, startServer } = fakeServer(4317);
    const t = testIo({}, { startServer, openBrowser: async () => true });
    expect(
      await runCli(['start', '--demo-stress', '--demo-projects', '20', '--no-open'], t.io),
    ).toBeNull();
    expect(calls[0]?.[1].demo).toEqual({ stress: true, projects: 20 });
    expect(await runCli(['start', '--demo', '--demo-projects', '20'], t.io)).toBe(2);
    expect(await runCli(['start', '--demo-stress', '--demo-projects', '0'], t.io)).toBe(2);
    expect(await runCli(['start', '--demo-stress', '--demo-projects', 'many'], t.io)).toBe(2);
    expect(t.err()).toContain('--demo-projects only applies to --demo-stress');
    expect(calls).toHaveLength(1);
  });

  it('prints the link when the browser cannot be opened', async () => {
    const { startServer } = fakeServer(4317);
    const t = testIo({}, { startServer, openBrowser: async () => false });
    await runCli(['start'], t.io);
    expect(t.out()).toContain('Sign in with: http://127.0.0.1:4317/auth?t=');
  });

  it('explains a busy port', async () => {
    const startServer = async () => {
      throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    };
    const t = testIo({}, { startServer, openBrowser: async () => true });
    expect(await runCli(['start'], t.io)).toBe(1);
    expect(t.err()).toContain('port 4317 is already in use');
  });

  it('really listens and serves health (real server, ephemeral port)', async () => {
    let app: FastifyInstance | undefined;
    const t = testIo(
      { YARDMASTER_PORT: '0' },
      { openBrowser: async () => true, onStarted: (started) => (app = started) },
    );
    expect(await runCli(['start', '--no-open'], t.io)).toBeNull();
    if (!app) throw new Error('server did not start');
    closers.push(() => (app as FastifyInstance).close());
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(await res.json()).toEqual({ ok: true, version: pkg.version });
  });
});

describe('default doctor deps', () => {
  it('detects a busy port', async () => {
    const deps = defaultDoctorDeps(home, {});
    const server: Server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closers.push(() => new Promise((done) => server.close(done)));
    const { port } = server.address() as { port: number };
    expect(await deps.isPortFree('127.0.0.1', port)).toBe(false);
  });

  it('returns undefined when nothing answers HTTP', async () => {
    const deps = defaultDoctorDeps(home, {});
    expect(await deps.getJson('http://127.0.0.1:1/api/health')).toBeUndefined();
  });

  it('runs commands with argument arrays', async () => {
    const deps = defaultDoctorDeps(home, {});
    expect(await deps.run(process.execPath, ['-e', 'process.stdout.write("hi")'])).toBe('hi');
    expect(await deps.run(join(home, 'missing-binary'), [])).toBeUndefined();
  });
});

describe('browserCommand', () => {
  const url = 'http://127.0.0.1:4317/auth?t=abc';
  it('picks the platform opener', () => {
    expect(browserCommand(url, 'darwin')).toEqual(['open', [url]]);
    expect(browserCommand(url, 'linux')).toEqual(['xdg-open', [url]]);
    expect(browserCommand(url, 'win32')).toEqual([
      'rundll32',
      ['url.dll,FileProtocolHandler', url],
    ]);
  });
});

describe('yardmaster hooks', () => {
  const settingsAt = () => join(home, 'cfg', 'settings.json');
  const env = () => ({ CLAUDE_CONFIG_DIR: join(home, 'cfg') });

  it('shows a diff for --dry-run and writes nothing', async () => {
    const run = testIo(env());
    expect(await runCli(['hooks', 'install', '--dry-run'], run.io)).toBe(0);
    expect(run.out()).toContain('+++ ');
    expect(run.out()).toContain('yardmaster-hook');
    expect(run.out()).toContain('Dry run: nothing was written.');
    await expect(stat(settingsAt())).rejects.toThrow();
  });

  it('asks before writing, and refuses without a terminal unless --yes', async () => {
    const noTty = testIo(env());
    expect(await runCli(['hooks', 'install'], noTty.io)).toBe(1);
    expect(noTty.err()).toContain('--yes');

    const declined = testIo(env(), { confirm: async () => false });
    expect(await runCli(['hooks', 'install'], declined.io)).toBe(1);
    expect(declined.out()).toContain('Nothing was written.');
    await expect(stat(settingsAt())).rejects.toThrow();

    const confirm = vi.fn(async () => true);
    const accepted = testIo(env(), { confirm });
    expect(await runCli(['hooks', 'install'], accepted.io)).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(accepted.out()).toContain('Installed the Yardmaster hook for 13 events');
  });

  it('install-hooks replaces the handlers installed under the old c-board name', async () => {
    const old = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/opt/old/bin/c-board-hook', async: true }] }],
      },
    };
    await mkdir(join(home, 'cfg'), { recursive: true });
    await writeFile(settingsAt(), JSON.stringify(old));
    const status = testIo(env());
    expect(await runCli(['hooks', 'status'], status.io)).toBe(1);
    expect(status.out()).toContain('outdated: Stop');

    const run = testIo(env());
    expect(await runCli(['install-hooks', '--yes'], run.io)).toBe(0);
    expect(run.out()).toMatch(/Backup: .*settings\.json\.yardmaster-backup-/);
    const after = await readFile(settingsAt(), 'utf8');
    expect(after).not.toContain('c-board-hook');
    expect(JSON.parse(after).hooks.Stop).toHaveLength(1);
    expect(await runCli(['hooks', 'status'], testIo(env()).io)).toBe(0);
  });

  it('installs, reports status, and uninstalls through --settings-path', async () => {
    const path = join(home, 'elsewhere', 'settings.json');
    const before = testIo();
    expect(await runCli(['hooks', 'status', '--settings-path', path], before.io)).toBe(1);
    expect(before.out()).toContain('0/13 hook events installed');

    expect(await runCli(['hooks', 'install', '--yes', '--settings-path', path], testIo().io)).toBe(
      0,
    );
    const again = testIo();
    expect(await runCli(['hooks', 'install', '-y', '--settings-path', path], again.io)).toBe(0);
    expect(again.out()).toContain('already installed');

    const status = testIo();
    expect(await runCli(['hooks', 'status', '--settings-path', path], status.io)).toBe(0);
    expect(status.out()).toContain('13/13 hook events installed');

    const removed = testIo();
    expect(await runCli(['hooks', 'uninstall', '--yes', '--settings-path', path], removed.io)).toBe(
      0,
    );
    expect(removed.out()).toContain('Backup: ');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({});
  });

  it('adds the away-mode permission hook only with --away', async () => {
    const path = join(home, 'away', 'settings.json');
    const args = ['--yes', '--settings-path', path];
    expect(await runCli(['hooks', 'install', ...args], testIo().io)).toBe(0);
    const plain = testIo();
    expect(await runCli(['hooks', 'status', '--settings-path', path], plain.io)).toBe(0);
    expect(plain.out()).toContain('Away-mode permission hook not installed');

    const away = testIo();
    expect(await runCli(['hooks', 'install', '--away', ...args], away.io)).toBe(0);
    expect(away.out()).toContain('and the away-mode permission hook');
    const handler = JSON.parse(await readFile(path, 'utf8')).hooks.PermissionRequest[0].hooks[0];
    expect(handler.command).toMatch(/yardmaster-hook --permission$/);
    expect(handler.async).toBeUndefined();
    const status = testIo();
    expect(await runCli(['hooks', 'status', '--settings-path', path], status.io)).toBe(0);
    expect(status.out()).toContain('Away-mode permission hook installed');

    const misuse = testIo();
    expect(await runCli(['hooks', 'uninstall', '--away', ...args], misuse.io)).toBe(2);
  });

  it('refuses invalid JSON and rejects unknown actions', async () => {
    const path = join(home, 'bad.json');
    await writeFile(path, '{ nope');
    const bad = testIo();
    expect(await runCli(['hooks', 'install', '--yes', '--settings-path', path], bad.io)).toBe(1);
    expect(bad.err()).toContain('is not valid JSON');
    expect(await readFile(path, 'utf8')).toBe('{ nope');

    const unknown = testIo();
    expect(await runCli(['hooks', 'wipe'], unknown.io)).toBe(2);
    expect(unknown.err()).toContain('expected one of install, uninstall, status');
  });
});
