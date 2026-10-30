import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GIT_INTERVAL_MS,
  type GitRunner,
  GitScanner,
  gitEnv,
  NOT_REPO_RECHECK_MS,
  runGit,
} from './git-scanner.js';
import { BoardStore } from './store.js';

const T0 = 1_760_000_000_000;
const OID = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
const z = (...records: string[]) => `${records.join('\0')}\0`;

const STATUS = z(
  `# branch.oid ${OID}`,
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -0',
  '? notes.md',
);
const LOG = z([OID, 'Dev One', '1760000000', 'Initial commit'].join('\x1f'));

function gitError(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { code: 128, stderr });
}

interface Repo {
  status: string | Error;
  log?: string | Error;
  /** `git config --list --show-scope --name-only -z` output. */
  config?: string;
}

function setup(repos: Record<string, Repo>, active = true) {
  const store = new BoardStore({ autoFlush: false, now: () => T0 });
  for (const [name, _repo] of Object.entries(repos)) {
    store.upsertProject({
      id: `p-${name}`,
      path: `/home/dev/${name}`,
      name,
      accent: 0,
      source: 'editor',
      git: null,
      createdAt: T0,
      lastActivityAt: null,
    });
  }
  store.flush();
  const calls: string[] = [];
  const run: GitRunner = async (dir, args) => {
    const repo = repos[dir.slice('/home/dev/'.length)];
    if (args[0] === 'config') return repo?.config ?? z('global', 'user.name');
    calls.push(`${dir} ${args[0]}`);
    const out = args[0] === 'status' ? repo?.status : repo?.log;
    if (out === undefined) throw gitError(`fatal: cannot change to '${dir}'`);
    if (out instanceof Error) throw out;
    return out;
  };
  const logger = { warn: vi.fn(), debug: vi.fn() };
  let now = T0;
  const state = { active };
  const scanner = new GitScanner({
    store,
    logger,
    run,
    active: () => state.active,
    now: () => now,
  });
  return { store, scanner, calls, logger, state, tick: (ms: number) => (now += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GitScanner', () => {
  it('fills GitInfo from status and log', async () => {
    const { store, scanner } = setup({ shop: { status: STATUS, log: LOG } });
    await scanner.tick();
    expect(store.state.projects['p-shop']?.git).toEqual({
      branch: 'main',
      head: OID,
      detached: false,
      dirty: 1,
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      files: [
        { path: 'notes.md', origPath: null, status: 'untracked', staged: false, unstaged: true },
      ],
      commits: [{ hash: OID, author: 'Dev One', at: 1_760_000_000_000, subject: 'Initial commit' }],
      updatedAt: T0,
    });
  });

  it('only polls while a UI client is connected', async () => {
    const { store, scanner, calls, state } = setup({ shop: { status: STATUS, log: LOG } }, false);
    await scanner.tick();
    expect(calls).toEqual([]);
    expect(store.state.projects['p-shop']?.git).toBeNull();
    state.active = true;
    await scanner.tick();
    expect(calls).toEqual(['/home/dev/shop status', '/home/dev/shop log']);
  });

  it('writes nothing when the repository is unchanged', async () => {
    const { store, scanner, tick } = setup({ shop: { status: STATUS, log: LOG } });
    await scanner.tick();
    store.flush();
    tick(GIT_INTERVAL_MS);
    await scanner.tick();
    expect(store.flush()).toEqual([]);
    expect(store.state.projects['p-shop']?.git?.updatedAt).toBe(T0);
  });

  it('skips the log for a repository without commits', async () => {
    const { store, scanner, calls } = setup({
      fresh: { status: z('# branch.oid (initial)', '# branch.head main') },
    });
    await scanner.tick();
    expect(calls).toEqual(['/home/dev/fresh status']);
    expect(store.state.projects['p-fresh']?.git).toMatchObject({ head: null, commits: [] });
  });

  it('skips folders outside git and rechecks them later', async () => {
    const { store, scanner, calls, logger, tick } = setup({
      notes: { status: gitError('fatal: not a git repository (or any parent): .git') },
    });
    await scanner.tick();
    await scanner.tick();
    expect(calls).toEqual(['/home/dev/notes status']);
    expect(store.state.projects['p-notes']?.git).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    tick(NOT_REPO_RECHECK_MS);
    await scanner.tick();
    expect(calls).toHaveLength(2);
  });

  it('clears git info when a folder stops being a repository', async () => {
    const repos: Record<string, Repo> = { shop: { status: STATUS, log: LOG } };
    const { store, scanner } = setup(repos);
    await scanner.tick();
    expect(store.state.projects['p-shop']?.git).not.toBeNull();
    repos.shop = { status: gitError('fatal: not a git repository') };
    await scanner.tick();
    expect(store.state.projects['p-shop']?.git).toBeNull();
  });

  it('keeps the last info when git fails, and warns once', async () => {
    const repos: Record<string, Repo> = { shop: { status: STATUS, log: LOG } };
    const { store, scanner, logger } = setup(repos);
    await scanner.tick();
    const before = store.state.projects['p-shop']?.git;
    repos.shop = { status: gitError('fatal: detected dubious ownership') };
    await scanner.tick();
    await scanner.tick();
    expect(store.state.projects['p-shop']?.git).toBe(before);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('turns itself off when git is not installed', async () => {
    const { scanner, calls, logger } = setup({
      shop: { status: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) },
    });
    await scanner.tick();
    await scanner.tick();
    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('coalesces hook-triggered refreshes, even without clients', async () => {
    vi.useFakeTimers();
    const { store, scanner, calls } = setup({ shop: { status: STATUS, log: LOG } }, false);
    scanner.request('p-shop');
    scanner.request('p-shop');
    scanner.request('p-shop');
    await vi.runOnlyPendingTimersAsync();
    expect(calls).toEqual(['/home/dev/shop status', '/home/dev/shop log']);
    expect(store.state.projects['p-shop']?.git?.branch).toBe('main');
  });

  it('rescans once more when asked during a scan', async () => {
    let release: () => void = () => {};
    const { store } = setup({});
    store.upsertProject({
      id: 'p-shop',
      path: '/home/dev/shop',
      name: 'shop',
      accent: 0,
      source: 'editor',
      git: null,
      createdAt: T0,
      lastActivityAt: null,
    });
    let statusCalls = 0;
    const scanner = new GitScanner({
      store,
      logger: { warn: vi.fn(), debug: vi.fn() },
      active: () => true,
      now: () => T0,
      run: async (_dir, args) => {
        if (args[0] === 'config') return '';
        if (args[0] === 'log') return LOG;
        statusCalls += 1;
        if (statusCalls === 1) await new Promise<void>((resolve) => (release = resolve));
        return STATUS;
      },
    });
    const first = scanner.scan('p-shop');
    void scanner.scan('p-shop');
    void scanner.scan('p-shop');
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    release();
    await first;
    await vi.waitFor(() => expect(statusCalls).toBe(2));
  });

  it('drops results for a project removed mid-scan', async () => {
    const { store, scanner } = setup({ shop: { status: STATUS, log: LOG } });
    const scan = scanner.scan('p-shop');
    store.removeProject('p-shop');
    await scan;
    expect(store.state.projects['p-shop']).toBeUndefined();
  });

  it('drops results after stop', async () => {
    const { store, scanner } = setup({ shop: { status: STATUS, log: LOG } });
    const scan = scanner.scan('p-shop');
    scanner.stop();
    await scan;
    expect(store.state.projects['p-shop']?.git).toBeNull();
  });

  it.each([
    ['a filter driver', z('local', 'filter.lfs.clean')],
    ['an fsmonitor', z('local', 'core.fsmonitor')],
    ['a hooks path', z('worktree', 'core.hookspath')],
    ['a *.command key', z('local', 'diff.Tool.command')],
    ['a *Command key', z('local', 'core.sshcommand')],
  ])('skips status for a repository whose config defines %s', async (_label, config) => {
    const { store, scanner, calls } = setup({ shop: { status: STATUS, log: LOG, config } });
    await scanner.tick();
    expect(calls).toEqual([]);
    expect(store.state.projects['p-shop']?.git).toMatchObject({
      statusSkipped: true,
      branch: null,
      dirty: 0,
    });
  });

  it('ignores command keys from the user and command-line config', async () => {
    const config = z(
      'global',
      'core.sshcommand',
      'command',
      'core.fsmonitor',
      'local',
      'user.name',
    );
    const { store, scanner, calls } = setup({ shop: { status: STATUS, log: LOG, config } });
    await scanner.tick();
    expect(calls).toEqual(['/home/dev/shop status', '/home/dev/shop log']);
    expect(store.state.projects['p-shop']?.git?.statusSkipped).toBeUndefined();
  });
});

const exec = promisify(execFile);

describe('runGit', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('skips the system config', () => {
    expect(gitEnv().GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('never runs a filter driver from a cloned repository', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ym-git-'));
    const marker = join(dir, 'ran');
    const git = (...args: string[]) => exec('git', ['-C', dir, ...args], { env: gitEnv() });
    await git('init', '-q');
    await git('config', 'filter.evil.clean', `touch ${marker}; cat`);
    writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(dir, 'notes.md'), 'hello\n');
    const store = new BoardStore({ autoFlush: false, now: () => T0 });
    store.upsertProject({
      id: 'p-evil',
      path: dir,
      name: 'evil',
      accent: 0,
      source: 'manual',
      git: null,
      createdAt: T0,
      lastActivityAt: null,
    });
    const calls: string[] = [];
    const scanner = new GitScanner({
      store,
      logger: { warn: vi.fn(), debug: vi.fn() },
      active: () => true,
      run: (cwd, args) => {
        calls.push(args[0] ?? '');
        return runGit(cwd, args);
      },
    });
    await scanner.tick();
    expect(calls).toEqual(['config']);
    expect(existsSync(marker)).toBe(false);
    expect(store.state.projects['p-evil']?.git?.statusSkipped).toBe(true);

    await git('config', '--unset', 'filter.evil.clean');
    await scanner.tick();
    expect(calls).toEqual(['config', 'config', 'status']);
    expect(store.state.projects['p-evil']?.git).toMatchObject({ dirty: 2 });
    expect(store.state.projects['p-evil']?.git?.statusSkipped).toBeUndefined();
  });
  it('never runs a filter driver from a submodule’s own config', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ym-git-'));
    const marker = join(dir, 'ran');
    const outer = join(dir, 'outer');
    const sub = join(outer, 'vendor');
    const git = (cwd: string, ...args: string[]) =>
      exec('git', ['-C', cwd, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], {
        env: gitEnv(),
      });
    await git(dir, 'init', '-q', outer);
    await git(outer, 'init', '-q', sub);
    writeFileSync(join(sub, 'notes.md'), 'hello\n');
    await git(sub, 'add', 'notes.md');
    await git(sub, 'commit', '-q', '-m', 'Initial commit');
    // The outer repository's config is clean; the submodule's isn't.
    await git(sub, 'config', 'filter.evil.clean', `touch ${marker}; cat`);
    writeFileSync(join(sub, '.gitattributes'), '* filter=evil\n');
    await git(outer, 'add', 'vendor');
    await git(outer, 'commit', '-q', '-m', 'Add vendor');
    // A changed mtime makes status compare the file's content, through the filter.
    utimesSync(join(sub, 'notes.md'), new Date(T0), new Date(T0));
    const store = new BoardStore({ autoFlush: false, now: () => T0 });
    store.upsertProject({
      id: 'p-outer',
      path: outer,
      name: 'outer',
      accent: 0,
      source: 'manual',
      git: null,
      createdAt: T0,
      lastActivityAt: null,
    });
    const scanner = new GitScanner({
      store,
      logger: { warn: vi.fn(), debug: vi.fn() },
      active: () => true,
      run: runGit,
    });
    await scanner.tick();
    expect(store.state.projects['p-outer']?.git?.statusSkipped).toBeUndefined();
    expect(store.state.projects['p-outer']?.git?.branch).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});
